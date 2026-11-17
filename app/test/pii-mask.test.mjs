import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateKoreanRRN,
  validateLuhn,
  validateIPv4,
  createPiiMaskContext,
  maskText,
  maskMessages,
  restoreText,
  restoreJsonPayload,
  createStreamRestorer,
  RULE_RRN,
  RULE_CARD,
  RULE_EMAIL,
  RULE_IPV4,
  RULE_PHONE,
  RULE_ACCOUNT,
  sanitizeText,
  detectAll,
  redactForLog
} from '../lib/pii-mask.mjs';

// A detection hint is caller text (a raw JSON key), so it may add context but never
// take coverage away. A `학번` key enabled a student-id span inside a structural
// address; outranking it in overlap resolution, that span displaced the address and
// left `테헤란로` and `101동` unmasked.
test('a context hint never shrinks what is detected without it', () => {
  const value = '서울시 강남구 테헤란로 12345678 101동';
  const plain = detectAll(value).map((f) => [f.rule, f.value]);
  assert.deepEqual(plain, [['korean_address', value]]);
  for (const hint of ['string-literal x.학번', 'string-literal x.계좌번호']) {
    assert.deepEqual(detectAll(value, { path: 'x.*', hint }).map((f) => [f.rule, f.value]), plain, hint);
  }
});

// A `.env` body is evidence of live credentials. A placeholder line is not
// evidence *against* it: it used to be dropped from the count and then the body
// was required to keep two surviving assignments, so appending
// `REDIS_AUTH=your_redis_password` to a body holding a real password pushed it
// under the threshold and the whole file was sent. The single-line fallbacks did
// not cover the gap either — `BARE_ASSIGNMENT` refused `@`, and
// `isSecretAssignment` refused values under 16 characters.
test('a placeholder line cannot lower the .env evidence threshold', () => {
  const withPlaceholder = detectAll('MYSQL_ROOT=rootpass1234\nREDIS_AUTH=your_redis_password');
  assert.deepEqual(withPlaceholder.map((f) => f.rule), ['env_file_body']);
  assert.match(withPlaceholder[0].value, /MYSQL_ROOT=rootpass1234/, 'the real line is reported, not just the file');

  const punctuated = detectAll('DB_PASS=Sup3rS3cretP@ssw0rd\nREDIS_AUTH=your_redis_password');
  assert.deepEqual(punctuated.map((f) => f.rule), ['env_file_body']);

  const threeLines = detectAll('MYSQL_ROOT=rootpass1234\nREDIS_AUTH=your_redis_password\nAPP_ENV=production');
  assert.deepEqual(threeLines.map((f) => f.rule), ['env_file_body']);

  // Two real lines keep the rule they had before: one body, one span.
  const twoReal = detectAll('MYSQL_ROOT=rootpass1234\nREDIS_AUTH=redispass5678');
  assert.deepEqual(twoReal.map((f) => [f.rule, f.variant]), [['env_file_body', 'dotenv']]);
  assert.equal(twoReal[0].value, 'MYSQL_ROOT=rootpass1234\nREDIS_AUTH=redispass5678');
});

// The legitimate exemption is the one the body carries: a sample file holds
// placeholders, not secrets. Ordinary configuration must stay exempt too — a
// threshold that turns `NODE_ENV=production` into a credential is not a fix.
test('a body of placeholders and ordinary configuration stays exempt', () => {
  for (const sample of [
    'MYSQL_ROOT=your_root_password\nREDIS_AUTH=changeme\nAPI_KEY=<insert-key>',
    'NODE_ENV=production\nDB_PORT=5432\nLOG_LEVEL=debug\nCACHE_TTL=300',
    'PATH=/usr/local/bin\nHOME=/home/app\nAPI_BASE=/api/v1',
  ]) {
    assert.deepEqual(detectAll(sample), [], sample);
  }
});

// The single-line path: a password that carries punctuation, and a short one.
test('single-line secrets with punctuation and short values are recognized', () => {
  assert.deepEqual(detectAll('DB_PASS=Sup3rS3cretP@ssw0rd').map((f) => f.rule), ['generic_secret']);
  assert.deepEqual(detectAll('DB_PASS=Sup3rS3cretP@ssw0rd').map((f) => f.variant), ['bare-env-assignment']);
  assert.deepEqual(detectAll('MYSQL_ROOT=rootpass1234').map((f) => f.rule), ['generic_secret']);
  assert.deepEqual(detectAll('export DB_PASSWORD="complexPassw0rdToken!234"').map((f) => f.rule), ['generic_secret']);
});

// The flat 4.3-bit entropy floor was unreachable below ~22 characters, so a
// neutral key (`MYSQL_ROOT` names no secret word) holding a real short password
// reported nothing. These are the four shapes the reviewer measured on the wire.
test('a neutral key with a short secret is a secret', () => {
  for (const body of [
    'MYSQL_ROOT=hunter22\nREDIS_HOST=cache1',
    'SERVICE_ACCOUNT=Kq7Rt2Xz9Lm4Np8Q\nAPP_ENV=production',
    'MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4\nREDIS_HOST=cache1',
    'MYSQL_ROOT=Kq7Rt2Xz9Lm4Np8Q2Wv3',
  ]) {
    assert.deepEqual(detectAll(body).map((f) => f.rule === 'env_file_body' || f.rule === 'generic_secret' ? 'secret' : f.rule), ['secret'], body);
  }
});

// The same relaxation must not turn ordinary configuration into a credential:
// a body of host names, addresses, versions and URLs still passes.
test('configuration values stay exempt from the neutral-key rule', () => {
  for (const body of [
    'REDIS_HOST=cache1\nNODE_ENV=production',
    'APP_VERSION=v1.2.3\nNODE_ENV=production',
    'SERVICE_URL=https://api.example.com/v1\nNODE_ENV=production',
    'NODE_ENV=production\nDB_PORT=5432\nLOG_LEVEL=debug\nCACHE_TTL=300',
    'CHARSET=utf8mb4\nMODEL=Qwen2.5-0.5B-Instruct\nTAG=local-hash-3gram-v1',
    'PUBLIC_KEY=b3BlbnNzaC1rZXktdjEAAAA\nNODE_ENV=production',
  ]) {
    assert.deepEqual(detectAll(body), [], body);
  }
});

// A placeholder carrying a digit is still documentation. It used to be refused as
// a secret on the single-line path, which stopped the session on a `.env.example`.
test('digit-bearing placeholders are exempt on both paths', () => {
  for (const text of ['DB_PASS=changeme1234', 'DB_PASS=your_password1234', 'MYSQL_ROOT=changeme1234', 'API_KEY=placeholder1234']) {
    assert.deepEqual(detectAll(text), [], text);
  }
  for (const body of ['DB_PASS=changeme1234\nNODE_ENV=production', 'DB_PASS=your_password1234\nAPP_ENV=production']) {
    assert.deepEqual(detectAll(body), [], body);
  }
});

// In dotenv syntax an inline comment needs whitespace before `#`; a `#` attached
// to value characters is part of the value. Cutting at every `#` masked
// `Zx9!Kq2@Lm7` and left `#Pz4` — the rest of the same password — on the wire.
test('a `#` attached to a value belongs to the value', () => {
  const single = detectAll('MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4');
  assert.deepEqual(single.map((f) => [f.rule, f.value]), [['generic_secret', 'MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4']]);

  const body = detectAll('MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4\nREDIS_HOST=cache1');
  assert.deepEqual(body.map((f) => f.rule), ['env_file_body']);
  assert.match(body[0].value, /#Pz4/, 'the whole password is one span');

  // A whitespace-preceded `#` is a comment and stays outside the value.
  const commented = detectAll('MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4 # rotated 2026-11');
  assert.deepEqual(commented.map((f) => f.value), ['MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4']);
  assert.doesNotMatch(commented[0].value, /rotated/, 'the comment is not part of the value');
  assert.deepEqual(detectAll('KEY=value # comment'), [], 'a plain comment is not a secret');

  // The masked text carries no fragment of the password either.
  for (const text of ['MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4', 'MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4\nREDIS_HOST=cache1']) {
    const masked = sanitizeText(text).text;
    assert.doesNotMatch(masked, /Pz4|Lm7|Zx9/, text);
  }
});

// A body's mask span runs to end of line, so an inline comment that quotes the
// secret it describes is masked with it. The value class still stops at the
// comment: a comment never decides detection, only what the mask covers.
test('a body comment quoting its own secret is masked with it', () => {
  const quoting = 'MYSQL_ROOT=hunter22 # hunter22\nREDIS_HOST=cache1';
  assert.deepEqual(detectAll(quoting).map((f) => f.rule), ['env_file_body']);
  const masked = sanitizeText(quoting).text;
  assert.doesNotMatch(masked, /hunter22/, 'no fragment of the secret survives, not even in the comment');

  // The comment is not what makes it a secret: the same body without it behaves
  // the same, and a comment on its own line does not turn config into a secret.
  assert.deepEqual(detectAll('MYSQL_ROOT=hunter22\nREDIS_HOST=cache1').map((f) => f.rule), ['env_file_body']);
  assert.deepEqual(detectAll('LOG_LEVEL=debug # short note\nNODE_ENV=production'), [], 'an unrelated short comment is not a secret');
  assert.deepEqual(detectAll('CACHE_TTL=300 # seconds\nNODE_ENV=production'), []);
});

// A CRLF body advanced each line start by `line.length + 1` while the `\r` sat
// unconsumed, so every later span drifted one character left: the mask ended one
// character short of the body and `[SECRET_1]ecret99` — a real fragment — went to
// the log surface through `redactForLog`, which feeds `bridge_error.stderr` frames.
test('a CRLF body masks whole, and the redacted log carries no fragment', () => {
  const crlf = [
    'DB_PASS=Sup3rS3cret!x',
    'REDIS_HOST=cache1',
    'NODE_ENV=production',
    'APP_PORT=8080',
    'LOG_LEVEL=debug',
    'CACHE_TTL=300',
    'API_BASE=/api/v1',
    'MAIL_FROM=ops',
  ].join('\r\n');
  const lf = crlf.replace(/\r\n/g, '\n');

  // Same body, same rule, same span width modulo the terminator it really has.
  assert.deepEqual(detectAll(crlf).map((f) => f.rule), ['env_file_body']);
  assert.equal(detectAll(crlf)[0].value, crlf, 'the span covers the whole CRLF body');
  assert.deepEqual(detectAll(lf).map((f) => f.rule), ['env_file_body']);

  for (const [label, text] of [['crlf', crlf], ['lf', lf]]) {
    const masked = sanitizeText(text).text;
    assert.doesNotMatch(masked, /ecret99|cret99|ret99|MAIL_FROM|ops$/, `${label}: no fragment survives the mask`);
    assert.equal(masked, '[SECRET_1]', `${label}: the whole body is one pseudonym`);

    const logged = redactForLog(text);
    assert.doesNotMatch(logged, /ecret99|cret99|ret99|MAIL_FROM|ops$/, `${label}: no fragment survives log redaction`);
    assert.equal(logged, '[REDACTED:env_file_body]', `${label}: the log carries only the rule name`);
  }

  // A body long enough that the drift exceeds the last line's own length used to
  // leave that last assignment entirely outside the span, so it survived whole.
  const long = ['DB_PASS=Sup3rS3cret!x', ...Array.from({ length: 24 }, (_, index) => `FILLER_${index}=filler${index}`), 'TAIL_TOKEN=LastSecret99'].join('\r\n');
  assert.deepEqual(detectAll(long).map((f) => f.rule), ['env_file_body']);
  const maskedLong = sanitizeText(long).text;
  assert.doesNotMatch(maskedLong, /LastSecret99|TAIL_TOKEN/, 'the last assignment is inside the span');
  assert.equal(maskedLong, '[SECRET_1]');
  assert.doesNotMatch(redactForLog(long), /LastSecret99|TAIL_TOKEN/);
});

// A quoted value is one token even when it contains spaces: a passphrase is
// written that way, and the old `/[\s`]/` guard forwarded `DB_PASS="correct horse
// battery"` verbatim because the value contained spaces. A bare value with spaces
// is still config prose, which is the distinction the guard was there to make.
test('a quoted passphrase with spaces is a secret, an unquoted sentence is not', () => {
  for (const quoted of ['DB_PASS="correct horse battery"', "DB_PASS='correct horse battery'"]) {
    const found = detectAll(quoted);
    assert.deepEqual(found.map((f) => f.rule), ['generic_secret'], quoted);
    assert.equal(found[0].value, quoted, `${quoted}: the quotes and the spaces are one span`);
    assert.doesNotMatch(sanitizeText(quoted).text, /correct|horse|battery/, 'no word of the passphrase survives');
  }

  // The same passphrase inside a body is one refused body, not a masked send.
  const body = 'DB_PASS="correct horse battery"\nREDIS_HOST=cache1';
  assert.deepEqual(detectAll(body).map((f) => f.rule), ['env_file_body']);
  assert.doesNotMatch(sanitizeText(body).text, /correct|horse|battery/);

  // Prose stays exempt in both shapes: unquoted, the value ends at the first space.
  for (const prose of ['NOTE=this is a config note', 'DB_PASS=this is a note', 'NOTE="this is a config note."', 'NOTE="the value is read from the environment"']) {
    assert.deepEqual(detectAll(prose), [], prose);
  }
});

// Base64 padding is one or two trailing `=` characters. The `=` guard reads that
// as "a code expression, not a literal", so a 17-byte random key was blocked
// unpadded and sent once padded — the documented residual was wider than stated.
test('a base64-padded random key is blocked exactly like its unpadded form', () => {
  const unpadded = 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao';
  const padded = `${unpadded}=`;
  for (const key of [unpadded, padded]) {
    const found = detectAll(`API_KEY=${key}`);
    assert.deepEqual(found.map((f) => f.rule), ['generic_secret'], key);
    assert.equal(found[0].value, `API_KEY=${key}`);
    assert.doesNotMatch(sanitizeText(`API_KEY=${key}`).text, /Kq7Rt2Xz|2Wv3Ao/, 'no fragment of the key survives');
  }
  // Two pads are the same pad: a 16-byte key ending `==` behaves the same.
  assert.deepEqual(detectAll('API_KEY=Kq7Rt2Xz9Lm4Np8Q2Wv3==').map((f) => f.rule), ['generic_secret']);

  // Every other `=` still means "this is an expression", not a secret.
  for (const expression of ['DB_PASS=some=value', 'DB_PASS=a=b=c=d=e']) {
    assert.deepEqual(detectAll(expression), [], expression);
  }
});

// A placeholder word anywhere in the value made `DB_PASS=pw_change_2026` read as
// documentation and the real password was sent. The word only counts when the
// whole value is placeholder-shaped: a placeholder word first, then nouns/counters.
test('a placeholder word inside a real password does not exempt it', () => {
  const secret = detectAll('DB_PASS=pw_change_2026');
  assert.deepEqual(secret.map((f) => f.rule), ['generic_secret'], 'pw_change_2026 is a password, not a placeholder');
  assert.doesNotMatch(sanitizeText('DB_PASS=pw_change_2026').text, /change_2026|pw_change/);

  for (const placeholder of ['DB_PASS=change_me_2026', 'DB_PASS=your_password1234', 'DB_PASS=changeme1234', 'API_KEY=placeholder1234', 'API_KEY=your_api_key_here', 'MYSQL_ROOT=your_root_password']) {
    assert.deepEqual(detectAll(placeholder), [], placeholder);
  }
  // The same line beside a real secret is still evidence of a live body.
  assert.deepEqual(detectAll('DB_PASS=change_me_2026\nMYSQL_ROOT=hunter22').map((f) => f.rule), ['env_file_body']);
});

// The body window was `[first assignment, last assignment]`, so a comment line
// *above* the first assignment that quotes the secret stayed outside the span and
// survived the mask. The window covers the whole body region the rule matched.
test('a leading comment quoting the secret is inside the body span', () => {
  const leading = '# DB_PASS=Sup3rS3cret!x\nMYSQL_ROOT=hunter22\nREDIS_HOST=cache1';
  const found = detectAll(leading);
  assert.deepEqual(found.map((f) => f.rule), ['env_file_body']);
  assert.equal(found[0].start, 0, 'the span starts at the comment, not at the first assignment');
  assert.equal(found[0].value, leading);

  const masked = sanitizeText(leading).text;
  assert.doesNotMatch(masked, /Sup3rS3cret|hunter22|DB_PASS|MYSQL_ROOT/, 'no fragment survives');
  assert.equal(masked, '[SECRET_1]');
  assert.doesNotMatch(redactForLog(leading), /Sup3rS3cret|hunter22/);

  // A trailing comment after the last assignment was already covered; both edges
  // are covered now, and an unrelated comment is still not a secret.
  const both = '# note: DB_PASS=Sup3rS3cret!x\nMYSQL_ROOT=hunter22\nREDIS_HOST=cache1\n# rotated by hunter22';
  assert.equal(detectAll(both)[0].value, both);
  assert.doesNotMatch(sanitizeText(both).text, /Sup3rS3cret|hunter22/);
  assert.deepEqual(detectAll('# deployment notes\nLOG_LEVEL=debug\nNODE_ENV=production'), []);
});

// The residual list in `detectors.mjs` (`isSecretAssignment` doc comment) is a
// claim about this build, so it is asserted here. Each entry is a value the guard
// is documented to keep sending; if a later change catches one, this test fails
// and the list has to be rewritten rather than left overstated.
test('every documented residual is still exactly as documented', () => {
  const residuals = [
    ['1 unquoted passphrase with spaces', 'DB_PASS=correct horse battery'],
    ['2 quoted prose (function words)', 'DB_PASS="the quick brown fox is not here"'],
    ['2 quoted prose (comma)', 'DB_PASS="correct, horse battery"'],
    ['2 quoted prose (function words, short)', 'DB_PASS="note for you"'],
    ['2 quoted value under the 12-character floor', 'DB_PASS="short note"'],
    ['3 a value shorter than 8 characters', 'DB_PASS=hunter2'],
    ['3 a .env value shorter than 3 characters', 'DB_PASS=ab\nMYSQL_ROOT=hunter22'],
    ['4 a glued lowercase key', 'dbpass=Sup3rS3cret!x'],
    ['4 a glued lowercase key with a pair', 'dbpass=admin:admin'],
    ['5 a base64 value that decodes to text', 'API_KEY=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRleHQ='],
    ['6 an `=` inside the value', 'API_KEY=Kq7R=t2Xz9Lm4Np8Q'],
    ['6 more than two trailing pads', 'API_KEY=Kq7Rt2Xz9Lm4Np8Q==='],
    ['7 a placeholder word first, then nouns', 'DB_PASS=your_company_secret99'],
    ['7 a placeholder word first, then a word', 'DB_PASS=change_pass_2026'],
    ['7 the placeholder word plus a noun', 'DB_PASS=your_company_pw'],
    ['7 a placeholder word and digits', 'DB_PASS=changeme1234'],
    ['7 a placeholder word glued to a noun', 'DB_PASS=yourpassword'],
    ['7 a placeholder word glued to a noun', 'DB_PASS=examplepassword'],
    ['7 a placeholder word glued to a noun', 'DB_PASS=example_password'],
    ['7 a placeholder word glued to a noun', 'DB_PASS=changemepassword'],
    ['7 a placeholder word glued to a noun and a counter', 'DB_PASS=yourkey99'],
    ['7 a placeholder word glued to a noun', 'DB_PASS=todopassword'],
    ['9 a lone neutral-key short line', 'MYSQL_ROOT=hunter22'],
    ['9 a colon pair under a neutral key', 'MYSQL_ROOT=root:rootpass'],
    ['10 a mixed-case word with no digit', 'DB_PASS=SuperSecretPass'],
    ['10 a capitalised word sequence', 'DB_PASS=CorrectHorseBattery'],
    ['10 a lowercase compound word', 'DB_PASS=hunterpass'],
    ['10 a lowercase sentence-like word', 'DB_PASS=minhasenhasecreta'],
    ['10 a digits-only value', 'DB_PASS=84226194'],
    ['11 a variable reference', 'DB_PASS=${DB_PASSWORD}'],
    ['11 a shell-style variable', 'DB_PASS=$DB_PASSWORD'],
    ['11 a vendor key template', 'API_KEY=sk-${OPENAI_KEY}'],
    ['13 an empty bracket', 'DB_PASS=[]'],
    ['13 a one-character bracket', 'DB_PASS=[x]'],
    ['3 a three-character value', 'DB_PASS=abc'],
    ['3 a short JSON member under a mode key', '{"db_pass":"hunter2"}'],
    ['3 a short YAML value under a mode key', 'db_pass: hunter2'],
    ['9 a colon pair under a neutral key in a body', 'MYSQL_ROOT=root:rootpass\nREDIS_HOST=cache1'],
    ['9 a colon pair under a neutral JSON key', '{"mysql_root":"root:rootpass"}'],
    ['12 a mode word on the right side', 'DB_PASS=admin:digest'],
    ['12 a digest pair with no digit', 'DB_PASS=md5:md5'],
    ['13 a documentation bracket with spaces', 'DB_PASS=[my secret pw]'],
    ['13 an angle-bracket template', 'DB_PASS=<your_token_here>'],
    ['14 a spaced bracket ends the bare value', 'DB_PASS=[note for you] Kq7Rt2Xz9'],
    ['14 a spaced bracket ends the YAML value', 'password: [note for you] Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['15 a second nesting level under a credential key', '{"password":{"nested":{"value":"Kq7Rt2Xz9Lm4Np8Q2Wv3Ao"}}}'],
    ['15 a member that is neither a wrapper nor a property', '{"password":{"hash":"Kq7Rt2Xz9Lm4Np8Q2Wv3Ao"}}'],
    ['17 a token behind a unit word', 'kv_per_token: int'],
    ['17 a token behind a unit word in an assignment', 'CHARS_PER_TOKEN = 3'],
    ['17 a token behind a unit word in a JSON member', '{"kv_per_token": 512}'],
    ['18 a hyphenated label under a credential key', 'provider_key: fixture-not-a-real-key'],
    ['18 a hyphenated label under a credential key', 'API_KEY=never-propagate'],
    ['18 a type annotation', 'api_key: Optional[str]'],
    ['18 a type annotation under a unit key', 'kv_per_token: int'],
    ['18 a value spelled like its own key', 'api_key=api_key'],
    ['18 a value that is only a secret word', "secret: 'SECRET'"],
    ['18 a value that is only a secret word', 'provider_key: SECRET'],
    ['18 a value made only of placeholder letters', '{"password":"xz"}'],
    ['19 a call expression under a credential key', 'password: get_secret("x")'],
    ['19 a bare call with no quoted argument', 'password=hunter2()'],
    ['19 a call shape in a code key-value', 'password: Sup3r(S3cret!x)'],
    ['19 a member chain', 'token = self._token'],
    ['19 a CI reference', 'password: ${{ secrets.DB_PASSWORD }}'],
    ['19 a schema word', 'password: required'],
    ['19 prose under a label', 'Password: enter it when prompted'],
    ['20 a bare word in code context', 'password: pw,'],
    ['20 a bare word after `{`', '{password: admin}'],
    ['20 an all-letter word after a trailing comma', 'password: hunterpass,'],
    ['20 a bare word in a spaced assignment', 'password = hunter'],
    ['20 several unquoted words outside code', 'password: correct horse 9'],
    ['19 a regex constant in source', '_CUDA_VERSION_PATTERN = re.compile(r"cuda[ _-]?(\\d{1,2})")'],
    ['19 a tokenizer pattern', '_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+")'],
    ['19 a pyformat placeholder', 'password: %(db_password)s'],
    ['19 a pyformat placeholder in an assignment', 'password=%(db_password)s'],
    ['19 a shell variable reference', 'password: $DB_PASSWORD'],
    ['19 an unquoted call argument', 'password = os.getenv("X", hunter2)'],
    ['19 a lookup name is not secret-shaped', 'password = keyring.get_password("svc", "user")'],
    ['19 a config fallback is not secret-shaped', 'password = os.getenv("DB_PASS", "postgres")'],
    ['19 a short fallback under a credential lookup', 'secret = os.getenv("SECRET", "dev")'],
    ['21 a count under a credential key', '{"token": 8192}'],
    ['21 a zero under a credential key', '{"password": 0}'],
    ['21 a numeric-only password is not caught', 'password: 544572'],
    ['21 a numeric-only password in a JSON member', '{"password": 544572}'],
  ];
  for (const [label, value, hint] of [
    ['16 a property segment ends the hint', 'hunter22', 'string-literal arguments.token_count'],
    ['16 a numeric property value', '8192', 'string-literal arguments.token_count'],
    ['1 a bare `key` is not a credential', 'A6API_KEY', 'string-literal arguments.key_env'],
    ['1 a bare `key` under a page cursor', 'cursor_abc123', 'string-literal arguments.pagination.next_key'],
  ]) {
    assert.deepEqual(detectAll(value, { path: 'arguments.*', hint }), [], `residual ${label} is no longer a residual`);
  }
  // Residual 17 is closed, not open: a key that leaves no room for another reading
  // (`password`) now catches a short value, so the list above must not claim it is
  // forwarded. The pair form is still a credential under the same key.
  const hintedShort = detectAll('hunter2', { path: 'arguments.*', hint: 'string-literal arguments.password' });
  assert.deepEqual(hintedShort.map(finding => [finding.rule, finding.variant]), [['generic_secret', 'hinted-value']], '17 a short value under a credential key is caught as a hinted credential');
  assert.ok(detectAll('sa:sa', { path: 'arguments.*', hint: 'string-literal arguments.password' }).length > 0, '17 pair under hint');
  for (const [label, text] of residuals) {
    assert.deepEqual(detectAll(text), [], `residual ${label} is no longer a residual: ${JSON.stringify(text)}`);
  }
  // Residual 8 is not "no finding": it is a finding whose mask leaves these
  // comment lines intact, so it is asserted on the masked text instead.
  assert.equal(sanitizeText('DB_PASS=Sup3rS3cret!x\n# rotated by hunter22').text, '[SECRET_1]\n# rotated by hunter22');
  assert.equal(sanitizeText('MYSQL_ROOT=hunter22\nREDIS_HOST=cache1\nplain prose\n# hunter22').text, '[SECRET_1]\nplain prose\n# hunter22');
  // And the ones the same list says are caught must stay caught.
  const caught = [
    'DB_PASS="correct horse battery"',
    'DB_PASS="opensesame mustard7"',
    'DB_PASS="Hello World 2026"',
    'PASSWORD="we will ship the report on friday"',
    'DB_PASS="The Quick Brown Fox"',
    'DB_PASS="friday report"',
    'DB_PASS=hunter22',
    'DB_PASS=Sup3rS3cretP@ssw0rd',
    'db_pass="Sup3rS3cret!x"',
    'API_KEY=Kq7Rt2Xz9Lm4Np8Q2Wv3Ao',
    'API_KEY=Kq7Rt2Xz9Lm4Np8Q2Wv3Ao=',
    'DB_PASS=pw_change_2026',
    'DB_PASS=your_boss_secret99',
    'DB_PASS=user:hunter22',
    'DB_PASS=admin:pw12345',
    'DB_PASS=YourP@ssword',
    'DB_PASS=rootpass1234',
    'MYSQL_ROOT=hunter22\nREDIS_HOST=cache1',
    // 12: an alphabetic `user:password` pair on a secret-worded key.
    'DB_PASS=admin:admin',
    'DB_PASS=admin:letmein',
    'DB_PASS=root:toor',
    'DB_PASS=postgres:postgres',
    'DB_PASS=mysql:mysql',
    'DB_PASS=user:secretpw',
    'DB_PASS=sa:sa',
    // 13: brackets are punctuation a password can carry.
    'DB_PASS=Kq7[Rt2]Xz9',
    'DB_PASS=Sup3r[Secret]99',
    // 19: only a call shape is exempt, not a literal that contains parentheses.
    'DB_PASS=Sup3r(S3cret)99',
    '{"password":"Sup3r(S3cret)99"}',
    'password: Sup3r(S3cret)99', 'DB_PASS=Sup3r(S3cret!x)',
    // 19: a secret-shaped quoted call argument is a literal, in any position.
    'password=SecretStr("Sup3rS3cret!x")', 'password = get_secret("Sup3rS3cret99!")',
    'password = os.getenv("DB_PASS", "Sup3rS3cret!x")', 'password: os.environ.get("X", "Sup3rS3cret!x")',
    // 19: the value ends at its own syntax — a note, a comment or a closer after it.
    'users: [{name: admin, password: Sup3rS3cret99}]', 'password: Sup3rS3cret99 -- see vault',
    'password: Sup3rS3cret99 [2026]', 'password: Sup3rS3cret99 {from vault}',
    'password: Sup3rS3cret99 <!-- rotated -->', 'password: Sup3rS3cret99 ] ', 'password: Sup3rS3cret99 (a) (b)',
    // 21: a quoted digit string is still a typed password.
    '{"password":"544572"}',
    // 19: a `$` not followed by a variable name is a literal.
    'password: $ecret99',
    // 19: the class is read from the value's span, not the enclosing line.
    '{ user: admin, password: Sup3rS3cret99 }', 'db: { host: db1, password: Sup3rS3cret99 }',
    '{"password": hunter2}', 'password: hunter2}', 'password: Sup3rS3cret99 /* rotated 2026 */',
    'password: Sup3rS3cret99 (rotated)',
    'DB_PASS="Sup3r\\d+x"',
    // 20: outside code context the same word is a literal.
    'password: hashedPassword', 'password: hunter2,', 'password = Kq7Rt2Xz9Lm4Np8Q2Wv3Ao',
    // 3: a structural pair is caught at any width.
    'DB_PASS=a:b', 'DB_PASS=ab:cd',
    // 4: a separated lowercase or camel-case key is read mid-line.
    'db_pass=Sup3rS3cret!x', 'dbPass=Sup3rS3cret!x', 'db_pass=admin:admin',
    // 12: md5/sha256 do not exempt a digit-bearing token.
    'DB_PASS=admin:md5', 'DB_PASS=user:md5', 'DB_PASS=admin:sha256', 'DB_PASS=admin:md5x',
    // 13: a documentation bracket exempts only its own span.
    'DB_PASS=[your_key]Kq7Rt2Xz9Lm4Np8Q2Wv3Ao', 'DB_PASS=<your_token_here>Kq7Rt2Xz9',
    'DB_PASS=Sup3r[redacted]S3cret99!', 'DB_PASS=[note for you]Kq7Rt2Xz9Lm4Np8Q2Wv3Ao',
  ];
  for (const text of caught) {
    assert.ok(detectAll(text).length > 0, `documented as caught but sent: ${JSON.stringify(text)}`);
  }
  // Configuration the same list calls exempt stays exempt — including every mode
  // word the colon-pair rule must not read as a credential.
  const exemptConfig = [
    'DB_PASS=localhost:5432', 'DB_PASS=127.0.0.1:8080', 'AUTH_MODE=basic:digest',
    'AUTH_SCHEME=bearer:jwt', 'TOKEN_TYPE=bearer:jwt', 'SECRET_BACKEND=vault:file',
    'LOG_LEVEL=info:debug', 'CIPHER=aes-256:gcm', 'LISTEN=0.0.0.0:8080',
    'TZ=Asia/Seoul', 'SCHEDULE=0 3 * * *', 'DB_PASS=[YOUR_KEY_HERE]',
    'DB_PASS=[redacted]', 'DB_PASS=[API_KEY]', 'DB_PASS=cache1', 'DB_PASS=10.0.0.5',
    'DB_PASS=v1.2.3', 'DB_PASS=https://example.com/health',
    // 12: a mode word on the right side is configuration whatever the key says.
    'DB_PASSWORD=basic:digest', 'DB_PASS=vault:file', 'DB_PASSWORD=bearer:jwt',
    // 12: a bare scheme word with no colon is not a colon pair at all.
    'DB_PASSWORD=ldap', 'PASSWORD=oauth', 'DB_PASS=mysql',
  ];
  for (const text of exemptConfig) {
    assert.ok(!detectAll(text).some((f) => f.rule === 'generic_secret' || f.rule === 'env_file_body'), text);
  }
});

// A placeholder word is documentation only as a whole segment. The old bare-prefix
// match exempted any value that merely *started* with the letters `your`, `example`,
// `changeme`, `todo` or `<`, so a live password glued to a placeholder word was
// sent — and inside a body it produced no finding at all.
test('a placeholder word glued to a secret is a secret', () => {
  const glued = [
    'DB_PASS=yourSup3rS3cret99!',
    'DB_PASS=YOURS3cret99',
    'DB_PASS=changemeKq7Rt2Xz',
    'DB_PASS=exampleS3cret99',
    'DB_PASS=todoKq7Rt2Xz9',
    'DB_PASS=<Sup3rS3cret!x>',
  ];
  for (const text of glued) {
    assert.deepEqual(detectAll(text).map((f) => f.rule), ['generic_secret'], text);
    assert.doesNotMatch(sanitizeText(text).text, /Sup3rS3cret99|S3cret99|Kq7Rt2Xz|S3cret/, `${text}: no fragment survives`);
  }
  // The body path: the same password beside another assignment used to report
  // nothing at all and mask to itself.
  const body = 'DB_PASS=yourSup3rS3cret99!\nREDIS_HOST=cache1';
  assert.deepEqual(detectAll(body).map((f) => f.rule), ['env_file_body']);
  assert.equal(sanitizeText(body).text, '[SECRET_1]');
  // Placeholder values written as documentation stay exempt on both paths.
  for (const text of ['DB_PASS=your_api_key_here', 'DB_PASS=your_password1234', 'DB_PASS=changeme', 'DB_PASS=examplepassword', 'DB_PASS=<your_token_here>']) {
    assert.deepEqual(detectAll(text), [], text);
  }
});

// A backtick, an unclosed `${`, and a `user:password` pair are things a password
// can contain; the old code read all three as code or as config and sent them.
test('a backtick, an unclosed interpolation and a colon pair are secrets', () => {
  const secret = [
    ['backtick', 'DB_PASS=Sup3r`S3cret!x', /Sup3r|S3cret/],
    ['unclosed `${`', 'DB_PASS=Sup3r${S3cret!x', /Sup3r|S3cret/],
    ['colon pair', 'DB_PASS=admin:pw12345', /pw12345/],
  ];
  for (const [label, text, fragment] of secret) {
    assert.deepEqual(detectAll(text).map((f) => f.rule), ['generic_secret'], label);
    assert.doesNotMatch(sanitizeText(text).text, fragment, `${label}: no fragment survives`);
  }
  // A real template literal and a real variable reference are still not literals.
  assert.deepEqual(detectAll('DB_PASS=${DB_PASSWORD}'), []);
  assert.deepEqual(detectAll('API_KEY=sk-${OPENAI_KEY}'), []);
});

// A classic-Mac body separates lines with `\r` alone. Splitting on `\n` made the
// whole body one line, so only a single-line rule could fire and every password
// after the first was sent.
test('a CR-only body masks whole', () => {
  for (const text of [
    'DB_PASS=Sup3rS3cret!x\rREDIS_HOST=cache1',
    'DB_PASS=hunter2212\rREDIS_HOST=cache1',
    'MYSQL_ROOT=hunter22\rREDIS_HOST=cache1\rAPP_ENV=production',
  ]) {
    assert.deepEqual(detectAll(text).map((f) => f.rule), ['env_file_body'], JSON.stringify(text));
    assert.equal(sanitizeText(text).text, '[SECRET_1]', JSON.stringify(text));
  }
});

// The colon is a structural signal: `user:pass` is a complete credential whether
// or not its halves carry digits, and `sa:sa` is one at five characters. The old
// rule read every alphabetic pair as a host/port or a label pair and sent it.
test('an alphabetic user:password pair on a secret key is a secret', () => {
  const pairs = [
    'DB_PASS=admin:admin',
    'DB_PASS=admin:letmein',
    'DB_PASS=root:toor',
    'DB_PASS=postgres:postgres',
    'DB_PASS=mysql:mysql',
    'DB_PASS=user:secretpw',
    'DB_PASS=sa:sa',
  ];
  for (const text of pairs) {
    assert.deepEqual(detectAll(text).map((f) => f.rule), ['generic_secret'], text);
    const secret = text.slice(text.indexOf('=') + 1).split(':');
    for (const half of secret) assert.doesNotMatch(sanitizeText(text).text, new RegExp(half), `${text}: ${half} survives`);
  }
  // In a body it is evidence, so the whole body is one span.
  for (const body of ['DB_PASS=admin:admin\nREDIS_HOST=cache1', 'DB_PASS=sa:sa\nREDIS_HOST=cache1']) {
    assert.deepEqual(detectAll(body).map((f) => f.rule), ['env_file_body'], body);
    assert.equal(sanitizeText(body).text, '[SECRET_1]');
  }
  // Mode words, ports, dotted hosts and schedules are settings, not credentials.
  // The right side decides: a `*_PASS` key holding `basic:digest` is the auth mode,
  // so the key word alone must not outrank the explicit mode word on the value side.
  const settings = [
    'AUTH_MODE=basic:digest', 'AUTH_SCHEME=bearer:jwt', 'TOKEN_TYPE=bearer:jwt',
    'SECRET_BACKEND=vault:file', 'LOG_LEVEL=info:debug', 'CIPHER=aes-256:gcm',
    'LISTEN=0.0.0.0:8080', 'TZ=Asia/Seoul', 'SCHEDULE=0 3 * * *',
    'DB_PASS=localhost:5432', 'DB_PASS=127.0.0.1:8080',
    'DB_PASSWORD=basic:digest', 'DB_PASS=vault:file', 'DB_PASSWORD=bearer:jwt',
    'PASS=info:debug', 'DB_PASS=user:none', 'DB_PASS=admin:file',
    'DB_PASSWORD=ldap', 'PASSWORD=oauth', 'DB_PASS=mysql',
  ];
  for (const text of settings) assert.deepEqual(detectAll(text), [], text);
});

// A `[...]` template says so in words; brackets are also punctuation a password
// can carry. Exempting every bracketed value sent both passwords below.
test('a bracketed password is a secret, a bracketed template is not', () => {
  for (const text of ['DB_PASS=Kq7[Rt2]Xz9', 'DB_PASS=Sup3r[Secret]99']) {
    assert.deepEqual(detectAll(text).map((f) => f.rule), ['generic_secret'], text);
    assert.doesNotMatch(sanitizeText(text).text, /Rt2|Secret/, `${text}: no fragment survives`);
  }
  for (const text of ['DB_PASS=[YOUR_KEY_HERE]', 'DB_PASS=[redacted]', 'DB_PASS=[API_KEY]', 'DB_PASS=[your_token_here]', 'DB_PASS=[masked]', 'DB_PASS=[x]', 'DB_PASS=[]']) {
    assert.deepEqual(detectAll(text), [], text);
  }
});

test('PII validation helpers: RRN, Luhn, and IPv4', () => {
  // Korean RRN checksum
  assert.equal(validateKoreanRRN('9001011234568'), true);
  assert.equal(validateKoreanRRN('900101-1234568'), true);
  assert.equal(validateKoreanRRN('9001011234567'), false); // invalid checksum
  assert.equal(validateKoreanRRN('9999991234568'), false); // invalid month

  // Luhn credit card
  assert.equal(validateLuhn('4532015112830366'), true);
  assert.equal(validateLuhn('4532-0151-1283-0366'), true);
  assert.equal(validateLuhn('4532015112830367'), false); // invalid Luhn

  // IPv4
  assert.equal(validateIPv4('127.0.0.1'), true);
  assert.equal(validateIPv4('192.168.1.100'), true);
  assert.equal(validateIPv4('256.0.0.1'), false);
  assert.equal(validateIPv4('01.02.03.04'), false); // leading zero
  assert.equal(validateIPv4('1.2.3'), false);
});

test('Deterministic masking covers all specified shapes and rejects checksum-invalid numbers', () => {
  const ctx = createPiiMaskContext('test-session');
  const input = [
    'Valid RRN: 900101-1234568',
    'Invalid RRN: 900101-1234567',
    'Valid Card: 4532-0151-1283-0366',
    'Invalid Card: 4532-0151-1283-0367',
    'Email: security-team@example.co.kr',
    'IPv4: 192.168.0.1',
    'Mobile phone: 010-1234-5678',
    'Landline phone: 02-987-6543',
    'International phone: +82 10 5555 4444',
    'Account run: 123-456789-0123'
  ].join('\n');

  const masked = maskText(input, ctx);

  // Check valid shapes are masked
  assert.doesNotMatch(masked, /900101-1234568/);
  assert.doesNotMatch(masked, /4532-0151-1283-0366/);
  assert.doesNotMatch(masked, /security-team@example\.co\.kr/);
  assert.doesNotMatch(masked, /192\.168\.0\.1/);
  assert.doesNotMatch(masked, /010-1234-5678/);
  assert.doesNotMatch(masked, /02-987-6543/);
  assert.doesNotMatch(masked, /\+82 10 5555 4444/);
  assert.doesNotMatch(masked, /123-456789-0123/);

  // Check invalid checksum numbers are preserved verbatim
  assert.match(masked, /900101-1234567/);
  assert.match(masked, /4532-0151-1283-0367/);

  // Check rule counts
  assert.equal(ctx.counts[RULE_RRN], 1);
  assert.equal(ctx.counts[RULE_CARD], 1);
  assert.equal(ctx.counts[RULE_EMAIL], 1);
  assert.equal(ctx.counts[RULE_IPV4], 1);
  assert.equal(ctx.counts[RULE_PHONE], 3);
  assert.equal(ctx.counts[RULE_ACCOUNT], 1);

  // Reversibility
  const restored = restoreText(masked, ctx.mapping);
  assert.equal(restored, input);
});

// SEC-01: tool-call arguments used to be "preserved verbatim", so a card number,
// an email and a phone in a path went to the provider inside a function call. They
// are now masked like any other slot — and restored on the inbound path, so the
// local tool still receives the real path and value.
test('Tool-call arguments are masked, stay parseable, and restore to the real values', () => {
  const ctx = createPiiMaskContext('tool-session');
  const messages = [
    {
      role: 'user',
      content: 'Please process refund for card 4532-0151-1283-0366 and email me at test@domain.com'
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'process_refund',
            arguments: JSON.stringify({
              card: '4532-0151-1283-0366',
              recipient_email: 'test@domain.com',
              path: '/data/users/010-1234-5678/account.json'
            })
          }
        }
      ]
    }
  ];

  const maskedMessages = maskMessages(messages, ctx);

  // User content was masked
  assert.doesNotMatch(maskedMessages[0].content, /4532-0151-1283-0366/);
  assert.doesNotMatch(maskedMessages[0].content, /test@domain\.com/);

  // Arguments are masked, and still parse as JSON
  const rawArguments = maskedMessages[1].tool_calls[0].function.arguments;
  assert.doesNotMatch(rawArguments, /4532-0151-1283-0366/);
  assert.doesNotMatch(rawArguments, /test@domain\.com/);
  assert.doesNotMatch(rawArguments, /010-1234-5678/);
  const parsed = JSON.parse(rawArguments);
  assert.deepEqual(Object.keys(parsed).sort(), ['card', 'path', 'recipient_email']);

  // Identity fields the model calls back into are untouched
  assert.equal(maskedMessages[1].tool_calls[0].id, 'call_123');
  assert.equal(maskedMessages[1].tool_calls[0].function.name, 'process_refund');

  // Inbound: the local tool receives the real local path and value again
  const restoredPayload = restoreJsonPayload({ choices: [{ message: maskedMessages[1] }] }, ctx.mapping);
  const restoredArguments = restoredPayload.choices[0].message.tool_calls[0].function.arguments;
  const restored = JSON.parse(restoredArguments);
  assert.equal(restored.card, '4532-0151-1283-0366');
  assert.equal(restored.recipient_email, 'test@domain.com');
  assert.equal(restored.path, '/data/users/010-1234-5678/account.json');
});

test('Stream restorer correctly handles placeholders split across SSE chunks', () => {
  const ctx = createPiiMaskContext('sse-session');
  const email = 'user@example.org';
  const placeholder = ctx.allocatePlaceholder(RULE_EMAIL, email);

  const restorer = createStreamRestorer(ctx.mapping);

  // Split placeholder into two chunks
  const splitIdx = Math.floor(placeholder.length / 2);
  const part1 = placeholder.slice(0, splitIdx);
  const part2 = placeholder.slice(splitIdx);
  const chunk1 = Buffer.from('data: {"choices":[{"delta":{"content":"Sent to ' + part1);
  const chunk2 = Buffer.from(part2 + ' successfully."}}]}\n\n');

  const out1 = restorer.processChunk(chunk1);
  const out2 = restorer.processChunk(chunk2);
  const flush = restorer.flush();

  const combined = Buffer.concat([out1, out2, flush]).toString('utf8');
  assert.match(combined, new RegExp(`Sent to ${email} successfully`));
  assert.doesNotMatch(combined, /__PII_/);
});

test('Round-trip non-streaming JSON payload restoration', () => {
  const ctx = createPiiMaskContext('json-session');
  const phone = '010-9999-8888';
  const placeholder = ctx.allocatePlaceholder(RULE_PHONE, phone);

  const upstreamPayload = {
    id: 'chatcmpl-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `Your phone number is ${placeholder}.`
        }
      }
    ]
  };

  const restored = restoreJsonPayload(upstreamPayload, ctx.mapping);
  assert.equal(restored.choices[0].message.content, `Your phone number is ${phone}.`);
  assert.doesNotMatch(restored.choices[0].message.content, /__PII_/);
});

// A/B/C leaks: structural credential shapes, hint-derived credential keys and
// bracket spans that used to exempt the whole value. Asserted on forwarded bytes.
async function forwarded(body) {
  const { screenOutbound } = await import('../privacy/index.mjs');
  const out = await screenOutbound({ body, sessionId: null, route: 'external' });
  return { action: out.action, wire: JSON.stringify(out.body) };
}
const chat = (content) => ({ messages: [{ role: 'user', content }] });
const toolArgs = (args) => ({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: JSON.stringify(args) } }] }] });

test('A/B/C: credential values are masked on the forwarded bytes', async () => {
  const cases = [
    ['{"password":"admin:admin"}', 'admin:admin'],
    ['password: admin:admin', 'admin:admin'],
    ['GET /x?API_KEY=Kq7Rt2Xz9Lm4Np8Q2Wv3Ao', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['run --password=admin:admin', 'admin:admin'],
    ['the value DB_PASS=Sup3rS3cret!x is set', 'Sup3rS3cret!x'],
    ['DB_PASS=[your_key]Kq7Rt2Xz9Lm4Np8Q2Wv3Ao', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['DB_PASS=<your_token_here>Kq7Rt2Xz9', 'Kq7Rt2Xz9'],
    ['DB_PASS=Sup3r[redacted]S3cret99!', 'S3cret99'],
    ['DB_PASS=[your_key]Kq7Rt2Xz9Lm4Np8Q2Wv3Ao\nREDIS_HOST=cache1', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
  ];
  for (const [text, secret] of cases) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`)]) {
      const { action, wire } = await forwarded(body);
      if (action === 'blocked') continue;
      assert.ok(!wire.includes(secret), text);
      assert.notEqual(wire, JSON.stringify(body), text);
    }
  }
  for (const [args, secret] of [
    [{ password: 'admin:admin' }, 'admin:admin'],
    [{ db_password: 'Sup3rS3cret!x' }, 'Sup3rS3cret!x'],
    [{ api_key: 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao' }, 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    [{ url: 'https://h.example/a?API_KEY=Kq7Rt2Xz9Lm4Np8Q2Wv3Ao' }, 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
  ]) {
    const body = toolArgs(args);
    const { action, wire } = await forwarded(body);
    if (action === 'blocked') continue;
    assert.ok(!wire.includes(secret), JSON.stringify(args));
  }
});

test('A/B/C: ordinary configuration still forwards unchanged', async () => {  for (const text of ['PORT=8080', 'REDIS_HOST=cache1','LOG_LEVEL=debug', 'URL=${DATABASE_URL}',
    'DB=localhost:5432', 'AUTH_MODE=basic:digest', 'DB_PASSWORD=basic:digest', 'DB_PASS=vault:file',
    'PASSWORD=oauth', 'DB_PASS=mysql', 'PASS=info:debug', 'DB_PASS=[your_key]', 'token_count: 8192']) {
    const body = chat(text);
    const { action, wire } = await forwarded(body);
    assert.equal(action, 'sent', text);
    assert.equal(wire, JSON.stringify(body), text);
  }
  const body = toolArgs({ token_count: 8192, password_policy: 'strict' });
  assert.equal((await forwarded(body)).wire, JSON.stringify(body));
});

// A bare `key`, `*_key` or `*Key` names a JSON key, a sort key, a page cursor or a
// React prop. Judging the `KEY` token alone made every one of them a credential, so
// pasting this repo's own `app/config.json` (`"key_env": "A6API_KEY"`) was refused
// and ordinary source was blocked. A value that names another variable
// (`process.env.X`, `os.environ[...]`, `os.getenv(...)`, `${X}`) is never a secret.
test('a bare key and a variable reference are not credentials on the wire', async () => {
  for (const text of [
    '{"key_env": "A6API_KEY"}',
    'sortKey: createdAt2',
    '{"key": "user_1234"}',
    '{"pagination": {"next_key": "cursor_abc123"}}',
    'password: process.env.DB_PASSWORD,',
    'api_key=os.environ["API_KEY"]',
    'key: value',
    'const firstKey = openTools.keys().next().value;',
    'password: readSecret()',
    '_CUDA_VERSION_PATTERN = re.compile(r"cuda[ _-]?(\\d{1,2})")',
    'api_key: os.getenv("API_KEY")',
    '{"token": ["a","b"]}',
    'password:\n  min_length: 8\n  policy: strict',
  ]) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`)]) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), text);
    }
  }
  for (const args of [
    { key_env: 'A6API_KEY' },
    { key: 'user_1234' },
    { pagination: { next_key: 'cursor_abc123' } },
    { api_key: '${API_KEY}' },
    { auth: { mode: 'basic:digest' } },
    { password: { strength: 'strong' } },
  ]) {
    const body = toolArgs(args);
    const { action, wire } = await forwarded(body);
    assert.equal(action, 'sent', JSON.stringify(args));
    assert.equal(wire, JSON.stringify(body), JSON.stringify(args));
  }
});

// Three shapes the credential-context rules missed: a single-quoted member
// (`{'password': 'admin:admin'}`), an object whose inner member carries the value
// (`{"password":{"value":"…"}}`), and any value under an unambiguous credential key
// that was too short for the length floor (`{"password":"hunter2"}`).
test('single-quoted, object-wrapped and short credential values are masked on the wire', async () => {
  const cases = [
    ["{'password': 'admin:admin'}", 'admin:admin'],
    ["creds = {'api_key': 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'}", 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['{"password":{"value":"Kq7Rt2Xz9Lm4Np8Q2Wv3Ao"}}', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['{"password":{"current":"OldP@ss1x","new":"NewP@ss2x"}}', 'OldP@ss1x'],
    ['{"password":{"current":"OldP@ss1x","new":"NewP@ss2x"}}', 'NewP@ss2x'],
    ['password:\n  value: Kq7Rt2Xz9Lm4Np8Q2Wv3Ao', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['{"password":"hunter2"}', 'hunter2'],
    ['password: hunter2', 'hunter2'],
    ['run --password hunter2', 'hunter2'],
    ['GET /x?password=hunter2', 'hunter2'],
    ['{password:"P@ss1!"}', 'P@ss1!'],
    ['{"password":"544572"}', '544572'],
    ['{"password":"admin"}', 'admin'],
    ['{"password":"123456"}', '123456'],
    ['{"password":"qwerty1"}', 'qwerty1'],
    ["{'client_secret': 'a'}", 'a'],
  ];
  for (const [text, secret] of cases) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`)]) {
      const { action, wire } = await forwarded(body);
      if (action === 'blocked') continue;
      assert.ok(!wire.includes(secret), `${text}: ${secret} reached the wire`);
      assert.notEqual(wire, JSON.stringify(body), text);
    }
  }
  for (const [args, secret] of [
    [{ password: 'hunter2' }, 'hunter2'],
    [{ password: '544572' }, '544572'],
    [{ db_password: 'hunter22' }, 'hunter22'],
    [{ password: { value: 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao' } }, 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    [{ api_key: 'Kq7Rt2Xz9' }, 'Kq7Rt2Xz9'],
  ]) {
    const body = toolArgs(args);
    const { action, wire } = await forwarded(body);
    if (action === 'blocked') continue;
    assert.ok(!wire.includes(secret), `${JSON.stringify(args)}: ${secret} reached the wire`);
  }
});

// Value shape classes: a quoted string or a `.env` literal is a value even when it
// carries parentheses, and a quoted literal passed to a call is judged as a value.
// The bytes must not reach the wire — masked (placeholder present) or blocked.
test('parenthesised literals and quoted call arguments are masked on the wire', async () => {
  const cases = [
    ['DB_PASS=Sup3r(S3cret!x)', 'Sup3r(S3cret!x)'],
    ['MYSQL_ROOT_PASSWORD=Kq7Rt2Xz9Lm4(Np8Q2Wv3Ao)', 'Kq7Rt2Xz9Lm4(Np8Q2Wv3Ao)'],
    ['DB_PASS=Sup3rS3cret(99)', 'Sup3rS3cret(99)'],
    ['{"password":"Sup3r(S3cret!x)"}', 'Sup3r(S3cret!x)'],
    ['password: Sup3r(S3cret)99', 'Sup3r(S3cret)99'],
    ['password=SecretStr("Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['token = Secret("Kq7Rt2Xz9Lm4Np8Q2Wv3Ao")', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['api_key = str("Kq7Rt2Xz9Lm4Np8Q2Wv3Ao")', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['password: decrypt("Sup3rS3cret!x")', 'Sup3rS3cret!x'],
  ];
  for (const [text, secret] of cases) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`), toolArgs({ code: text })]) {
      const { action, wire } = await forwarded(body);
      if (action === 'blocked') continue;
      assert.ok(!wire.includes(secret), `${text}: ${secret} reached the wire`);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, text);
    }
  }
  for (const [args, secret] of [
    [{ password: 'Sup3r(S3cret!x)' }, 'Sup3r(S3cret!x)'],
    [{ api_key: 'f(Kq7Rt2Xz9Lm4Np8Q2Wv3Ao)' }, 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
  ]) {
    const body = toolArgs(args);
    const { action, wire } = await forwarded(body);
    if (action === 'blocked') continue;
    assert.ok(!wire.includes(secret), `${JSON.stringify(args)}: ${secret} reached the wire`);
  }
});

// Code, references and prose under a credential key are not values: an identifier,
// a member chain, a subscript, a constructor, an f-string, a `${…}` or `!Ref`
// reference, a schema word or a sentence is forwarded unchanged.
test('code, references and prose under a credential key forward unchanged', async () => {
  const texts = [
    'token = self._token', 'password: req.body.password,', 'password: hashedPassword,',
    '{ password: hashedPassword, email }', 'token: accessToken,', 'password: pw,',
    'secret: secretValue,', 'password = args.password', 'token = tokens[0]',
    "password = request.form['password']", 'token = new Token()', 'token = f"Bearer {tok}"',
    'password: ${DB_PASSWORD}', 'token: ${{ secrets.GITHUB_TOKEN }}',
    'password: ${{ secrets.DB_PASSWORD }}', 'password: !Ref DbPassword',
    'api_key = (os.environ.get(ENV_API_KEY) or "").strip()', 'f"route={self.route!r}, api_key=<redacted>)"',
    'Password: enter it when prompted', 'Password: enter your password below',
    'token: a short string the server issues per session', 'password: required',
    '{"password":"string"}', 'token: this.token,', 'password=hunter2()',
  ];
  for (const text of texts) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`)]) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), text);
    }
  }
  for (const args of [
    { code: 'password: hashedPassword,' }, { code: 'token = self._token' }, { password: 'string' },
    { code: 'api_key = (os.environ.get(ENV_API_KEY) or "").strip()' }, { code: 'api_key=<redacted>)' },
    { code: 'password: ${DB_PASSWORD}' }, { code: 'token: ${{ secrets.GITHUB_TOKEN }}' }, { code: 'password: !Ref DbPassword' },
  ]) {
    const body = toolArgs(args);
    const { action, wire } = await forwarded(body);
    assert.equal(action, 'sent', JSON.stringify(args));
    assert.equal(wire, JSON.stringify(body), JSON.stringify(args));
  }
});

// The value class is read from the value's own span, not the rest of its line;
// every quoted call argument is a literal; `$` + a non-variable is a literal; a
// pyformat placeholder is a reference. Asserted single-line, in-body and as a
// tool argument.
test('enclosing syntax, call fallbacks and `$` literals are judged on the wire', async () => {
  const leaks = [
    ['{ user: admin, password: Sup3rS3cret99 }', 'Sup3rS3cret99'],
    ['db: { host: db1, password: Sup3rS3cret99 }', 'Sup3rS3cret99'],
    ['{user: admin, password: Sup3rS3cret99}', 'Sup3rS3cret99'],
    ['{"password": hunter2}', 'hunter2'],
    ['password: hunter2}', 'hunter2'],
    ['password: Sup3rS3cret99 /* rotated 2026 */', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 (rotated)', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99,', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99;', 'Sup3rS3cret99'],
    ['password = os.getenv("DB_PASS", "Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['password: os.environ.get("X", "Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['password: $ecret99', '$ecret99'],
  ];
  for (const [text, secret] of leaks) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`), toolArgs({ code: text })]) {
      const { action, wire } = await forwarded(body);
      if (action === 'blocked') continue;
      assert.ok(!wire.includes(secret), `${text}: ${secret} reached the wire`);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, text);
    }
  }
  for (const text of ['password=%(db_password)s', 'password: %(db_password)s', 'password: $DB_PASSWORD', '{"token": ["a","b"]}']) {
    for (const body of [chat(text), chat(`config:\n${text}\nend`), toolArgs({ code: text })]) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), text);
    }
  }
});

// One span scanner decides where an unquoted value ends, a quoted call argument is
// judged by its own shape, and a number is never a secret. Asserted on the
// forwarded bytes, single-line, in-body and as a tool argument.
test('the value span ends at its own syntax and call arguments are judged by shape', async () => {
  const forms = (text) => [chat(text), chat(`config:\n${text}\nend`), toolArgs({ code: text })];
  const forwardedUnchanged = [
    'password = os.getenv("DB_PASS", "postgres")', 'password = os.getenv("DB_PASS", "5432")',
    'password = os.getenv("DB_PASS", "pg")', 'password = os.getenv("DB_PASS", "postgresql")',
    'secret = os.getenv("SECRET", "dev")', 'secret = os.getenv("SECRET", "xyz")',
    'secret_key = config.get("secret_key", "default")', 'password = config.get("password", "dev")',
    'token = os.getenv("TOKEN", "dev")', 'api_key = os.getenv("API_KEY", "dev")',
    'secret = os.getenv("SECRET", os.environ["OTHER"])', 'password = keyring.get_password("svc", "user")',
    '{"token": 8192}', '{"password": 0}', 'max_tokens: 4096', 'port: 5432',
    '{"code":"password: hashedPassword,"}', 'app/config.json',
  ];
  for (const text of forwardedUnchanged) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), text);
    }
  }
  for (const args of [{ token: 8192 }, { password: 0 }, { max_tokens: 4096 }]) {
    const body = toolArgs(args);
    const { action, wire } = await forwarded(body);
    assert.equal(action, 'sent', JSON.stringify(args));
    assert.equal(wire, JSON.stringify(body), JSON.stringify(args));
  }
  const leaks = [
    ['users: [{name: admin, password: Sup3rS3cret99}]', 'Sup3rS3cret99'],
    ['[{password: Sup3rS3cret99}]', 'Sup3rS3cret99'],
    ['accounts: [{password: Sup3rS3cret99}]', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 -- see vault', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 [2026]', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 {from vault}', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 <!-- rotated -->', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 ] ', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 (a) (b)', 'Sup3rS3cret99'],
    ['- {password: Sup3rS3cret99}', 'Sup3rS3cret99'],
    ['{ password: Sup3rS3cret99, }', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 # note', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 // note', 'Sup3rS3cret99'],
    ['password: Sup3rS3cret99 /* a */ /* b */', 'Sup3rS3cret99'],
    ['password = os.getenv("DB_PASS", "Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['password: os.environ.get("X", "Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['password = get_secret("Sup3rS3cret99!")', 'Sup3rS3cret99!'],
    ['password = SecretStr("Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['token = Secret("Kq7Rt2Xz9Lm4Np8Q2Wv3Ao")', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao'],
    ['api_key = str("Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['password: decrypt("Sup3rS3cret!x")', 'Sup3rS3cret!x'],
    ['password: sa:sa', 'sa:sa'],
    ['password: admin:admin', 'admin:admin'],
    ['?password=hunter2', 'hunter2'],
    ['--password hunter2', 'hunter2'],
  ];
  for (const [text, secret] of leaks) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      if (action === 'blocked') continue;
      assert.ok(!wire.includes(secret), `${text}: ${secret} reached the wire`);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, text);
    }
  }
});

// A secret-shaped quoted argument carries the secret even when no credential key
// sits on the left: `get_secret("Sup3rS3cret99!")` names no credential on the LHS
// and the argument *is* the credential. The finding is MASK-ONLY — shape is
// evidence that a literal is a secret, not that a key vouches for it — so the
// bytes are replaced and the request still goes through. Blocking is unchanged
// where a credential key is present (asserted by the keyed tests above).
test('a secret-shaped call argument is masked without a credential key, and never refused', async () => {
  const forms = (text) => [chat(text), chat(`config:\n${text}\nend`), toolArgs({ code: text })];
  const leaks = [
    'os.getenv("DB_PASS", "Sup3rS3cret!x")',
    'os.environ.get("X", "Sup3rS3cret!x")',
    'get_secret("Sup3rS3cret99!")',
    'SecretStr("Sup3rS3cret!x")',
    'Secret("Kq7Rt2Xz9Lm4Np8Q2Wv3Ao")',
    'decrypt("Sup3rS3cret!x")',
    // The same three call forms behind an ordinary left-hand side, so no credential
    // key is in scope: the call and the shape of the literal carry the verdict.
    'mode = os.getenv("APP_MODE", "zzTestToken9x!Q")',
    'cache = config.get("password", "Q7x2Lm9Pw4")',
    'blob = decrypt("zzTestToken9x!Q")',
  ];
  for (const text of leaks) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', `${text}: a keyless argument must never be refused`);
      assert.doesNotMatch(wire, /Sup3rS3cret|Kq7Rt2Xz9|zzTestToken9x|Q7x2Lm9Pw4/, text);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, text);
    }
  }
  // A configuration argument is not a secret, and the same call around it is no
  // reason to touch the bytes.
  const unchanged = [
    'os.getenv("DB_PASS", "postgres")', 'os.getenv("DB_PASS", "5432")',
    'os.getenv("DB_PASS", "pg")', 'os.getenv("DB_PASS", "postgresql")',
    'os.getenv("SECRET", "dev")', 'config.get("password", "dev")',
    'println("hello world")', 'format("MSA %s", x)', 're.compile("^[a-z]+$")',
    'Date("2026-11-16")', 'path.join("a", "b")',
  ];
  for (const text of unchanged) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), text);
    }
  }
  // There is no documentation escape on this path: a sample inside a backtick span,
  // a live interpolation in a template literal, a wrapper call around the credential
  // call, a literal in a nested call and a second quoted copy of the same value are
  // all masked. Masking one copy and recording the value in the vault left the other
  // copy on the wire, and the recheck refused a request this rule had judged
  // mask-and-send.
  const shaped = [
    ['both copies, one in backticks', 'Rule: `get_secret("zzTestToken9x!Q")`\nExample: get_secret("zzTestToken9x!Q")'],
    ['a second quoted copy', 'decrypt("zzTestToken9x!Q") and "zzTestToken9x!Q"'],
    ['a second single-quoted copy', "decrypt('zzTestToken9x!Q') and 'zzTestToken9x!Q'"],
    ['a template-literal interpolation', 'const s = `${decrypt("zzTestToken9x!Q")}`;'],
    ['a literal in a nested call', 'const a = decrypt(str("zzTestToken9x!Q"));'],
    ['a literal in a nested lookup', 'const b = get_secret(os.environ.get("X", "zzTestToken9x!Q"));'],
    // A credential call wrapped by one that names no credential: the outer call must
    // not consume the scan, or the inner one is never examined.
    ['inside console.log', 'console.log(get_secret("zzTestToken9x!Q"))'],
    ['inside a cast', 'String(decrypt("zzTestToken9x!Q"))'],
    ['inside an encoder', 'encode(SecretStr("zzTestToken9x!Q"))'],
    ['inside an assertion', 'assert.ok(decrypt("zzTestToken9x!Q"))'],
  ];
  for (const [label, text] of shaped) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', `${label}: a keyless argument must never be refused`);
      assert.ok(!wire.includes('zzTestToken9x'), `${label}: the value reached the wire`);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, label);
    }
  }
  // Only quoted copies are rewritten. The same value is also a substring of an
  // unrelated identifier, a path segment and a quoted handle, and a plain substring
  // pass rewrote those bytes (`…Store`, `/opt/…/bin`, `"user_…"`). An unquoted copy
  // is left byte-identical; because it is then still on the wire, the request is
  // refused — the safe outcome — rather than forwarded in pieces.
  const embedded = [
    ['an identifier suffix', 'decrypt("zzTest12") and zzTest12Store'],
    ['a path segment', 'decrypt("zzTest12") and /opt/zzTest12/bin'],
    ['a quoted handle', 'decrypt("zzTest12") and "user_zzTest12"'],
  ];
  for (const [label, text] of embedded) {
    for (const body of forms(text)) {
      const { wire } = await forwarded(body);
      for (const fragment of ['zzTest12Store', '/opt/zzTest12/bin', 'user_zzTest12']) {
        if (text.includes(fragment)) assert.ok(wire.includes(fragment), `${label}: ${fragment} was rewritten`);
      }
    }
  }
  // A multi-line call is ordinary formatting: the span crosses line breaks, so the
  // argument is read and masked like a single-line one.
  for (const text of [
    'cfg = os.getenv(\n  "DB_PASS",\n  "zzTestToken9x!Q"\n)',
    'v = get_secret(\n  "zzTestToken9x!Q"\n)',
    'def f():\n    v = get_secret(\n        "zzTestToken9x!Q"\n    )\n',
  ]) {
    for (const body of [chat(text), toolArgs({ code: text })]) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.ok(!wire.includes('zzTestToken9x'), `${text}: the value reached the wire`);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, text);
    }
  }
  // A long earlier argument must not hide a later one: every literal in the span is
  // judged, so the secret after a 201- and a 300-character argument is masked.
  for (const pad of [201, 300]) {
    const text = `x = get_secret("${'a'.repeat(pad)}", "zzTestToken9x!Q")`;
    for (const body of [chat(text), toolArgs({ code: text })]) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', `pad ${pad}`);
      assert.ok(!wire.includes('zzTestToken9x'), `pad ${pad}: the value reached the wire`);
      assert.match(wire, /\[SECRET_\d+\]|__PII_/, `pad ${pad}`);
    }
  }
  // A config-shaped value reaches this rule through its digit, but it carries no
  // secret evidence, so its verdict must not be copied onto another literal: the
  // unrelated `codec`/`runtime` literal keeps its exact bytes. (The surviving copy
  // is then unreachable, so the request is refused — never forwarded in pieces.)
  const forwardedText = (wire) => {
    const first = JSON.parse(wire).messages[0];
    if (typeof first.content === 'string' && first.content) return first.content;
    const args = first.tool_calls?.[0]?.function?.arguments ?? '';
    try { return Object.values(JSON.parse(args)).join('\n'); } catch { return args; }
  };
  for (const [text, keep] of [
    ['const codec = "utf8_bin"; const m = os.getenv("APP_MODE", "utf8_bin")', 'const codec = "utf8_bin"'],
    ['if (runtime === "node20x1") { const r = os.getenv("APP_MODE", "node20x1"); }', 'runtime === "node20x1"'],
  ]) {
    for (const body of [chat(text), toolArgs({ code: text })]) {
      const { wire } = await forwarded(body);
      assert.ok(forwardedText(wire).includes(keep), `${text}: ${keep} was rewritten`);
    }
  }
  // Case and a `*` segment are naming in an underscore-joined identifier, not
  // secret evidence: neither the comparator nor a JSON key holding the same value
  // is rewritten. The value itself is not forwarded either — the untouched copy
  // is on the wire, so the request is refused (422) instead of rewritten.
  for (const value of ['Prod_001', 'Standard_LRS2', 'MyApp_v1', 'Release_2026', 'Node_V20', 'X_Trace_Id1', 'us_east_1A', 'cron_0_0_*']) {
    for (const [text, keep] of [
      [`env = os.getenv("APP_ENV", "${value}")\nif (env === "${value}") deploy();`, `env === "${value}"`],
      [`get_secret("${value}"); const m = {"${value}": 3};`, `{"${value}": 3}`],
    ]) {
      for (const body of [chat(text), toolArgs({ code: text })]) {
        const { action, wire } = await forwarded(body);
        assert.ok(forwardedText(wire).includes(keep), `${value}: ${keep} was rewritten`);
        assert.equal((wire.match(/\[SECRET_\d+\]|__PII_/g) ?? []).length, 1, `${value}: only the call copy is masked`);
        assert.equal(action, 'blocked', `${value}: an unreachable copy must be refused, not sent`);
      }
    }
  }
  // A password whose segments are not dictionary-shaped (a camelCase run of three
  // or more capitals, a digit inside a word) is not a config identifier, so it
  // keeps propagating: both copies are masked and the request is sent.
  for (const value of ['XkQzMn_8841', 'QxZvBnMk_8841', 'Kp7_Lm4_Qz9_Vb2', 'GhnKlmPq_2024']) {
    for (const text of [
      `env = os.getenv("APP_ENV", "${value}")\nif (env === "${value}") deploy();`,
      `get_secret("${value}"); const m = {"${value}": 3};`,
    ]) {
      for (const body of [chat(text), toolArgs({ code: text })]) {
        const { action, wire } = await forwarded(body);
        assert.equal(action, 'sent', `${value}: ${text}`);
        assert.ok(!wire.includes(value), `${value}: a copy reached the wire`);
        assert.equal((wire.match(/\[SECRET_\d+\]|__PII_/g) ?? []).length, 2, `${value}: both copies masked`);
      }
    }
  }
  // A genuine secret in the same two shapes still masks in both copies.
  for (const value of ['Kq7Rt2Xz9Lm4Np8Q', 'zzTestToken9x!Q', 'Sup3rS3cret99']) {
    for (const text of [
      `env = os.getenv("APP_ENV", "${value}")\nif (env === "${value}") deploy();`,
      `get_secret("${value}"); const m = {"${value}": 3};`,
    ]) {
      for (const body of [chat(text), toolArgs({ code: text })]) {
        const { action, wire } = await forwarded(body);
        assert.equal(action, 'sent', text);
        assert.ok(!wire.includes(value), `${text}: a copy reached the wire`);
        assert.equal((wire.match(/\[SECRET_\d+\]|__PII_/g) ?? []).length, 2, text);
      }
    }
  }
  // A literal that carries a secret word is a lookup NAME only when it is spelled as
  // one; with a digit, mixed case or entropy it is the value and is masked.
  for (const value of ['MyPassword_2025', 'my_secret_44xQ', 'api_token_9f2k3m']) {
    for (const text of [`v = get_secret("${value}")`, `v = decrypt("${value}")`]) {
      for (const body of forms(text)) {
        const { action, wire } = await forwarded(body);
        assert.equal(action, 'sent', text);
        assert.ok(!wire.includes(value), `${text}: the value reached the wire`);
        assert.match(wire, /\[SECRET_\d+\]|__PII_/, text);
      }
    }
  }
  for (const text of ['v = get_secret("DB_PASSWORD")', 'v = get_secret("db_password")', 'v = get_secret("API_KEY_2")', 'v = decrypt("api.token")']) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), `${text}: a lookup name was rewritten`);
    }
  }
  // The call name is read as identifier words, not as a substring: `tokenize` holds
  // `token` without naming a credential, so its argument is ordinary code.
  for (const text of ['tokenize("zzTestToken9x!Q")', 'secretive("zzTestToken9x!Q")', 'vaultless("Q7x2Lm9Pw4")']) {
    for (const body of forms(text)) {
      const { action, wire } = await forwarded(body);
      assert.equal(action, 'sent', text);
      assert.equal(wire, JSON.stringify(body), text);
    }
  }
});

// Structural limit of per-slot detection, asserted rather than left implicit: this
// rule reads ONE slot (one message content, one tool-argument string). When the same
// value also appears unquoted in the same slot, or in another slot than the masked
// call, nothing rewrites it and the post-mask recheck refuses the request (422)
// instead of forwarding the value. Refusing is the safe outcome; reaching across
// slots would mean the detector becomes payload-global.
test('a copy this per-slot rule cannot reach is refused, not forwarded', async () => {
  const unquoted = 'decrypt("zzTestToken9x!Q") and later bare zzTestToken9x!Q';
  for (const body of [chat(unquoted), toolArgs({ code: unquoted })]) {
    const { action } = await forwarded(body);
    assert.equal(action, 'blocked', 'an unquoted copy in the same slot must be refused, not sent raw');
  }
  for (const body of [
    { messages: [{ role: 'user', content: 'decrypt("zzTestToken9x!Q")' }, { role: 'user', content: 'and zzTestToken9x!Q' }] },
  ]) {
    const { action } = await forwarded(body);
    assert.equal(action, 'blocked', 'a copy in another slot must be refused, not sent raw');
  }
});
