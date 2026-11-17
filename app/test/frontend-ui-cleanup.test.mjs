import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewModel, applyFrame, addPendingPrompt, transcriptEntries, sessionTokens, costLabel, UNPRICED_REMOTE, resolvedModel, sessionStatus, verifyStatement, privacyRecord, privacyLine } from '../public/protocol.js';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;

test('item 1: an unpriced remote turn never renders $0.000', () => {
  assert.equal(costLabel(0, { remote:true }), UNPRICED_REMOTE);
  assert.equal(costLabel(null, { remote:true }), UNPRICED_REMOTE);
  assert.equal(costLabel(0.051, { remote:true }), '$0.051');
  assert.ok(!costLabel(0, { remote:false }).includes('$0.000'));
});

test('item 2: one token figure; a pre-turn stats reply of 0 does not mask live usage', () => {
  const vm = createViewModel();
  applyFrame(vm, { type:'response', command:'get_session_stats', success:true, data:{ tokens:{ total:0 } } });
  assert.equal(sessionTokens(vm), null);
  applyFrame(vm, { type:'message_end', message:{ role:'assistant', content:'ok', usage:{ totalTokens:212100 } } });
  assert.equal(sessionTokens(vm), 212100);
  applyFrame(vm, { type:'response', command:'get_session_stats', success:true, data:{ tokens:{ total:0 } } });
  assert.equal(sessionTokens(vm), 212100);
});

test('item 3: one resolved model with its decision source, the core endpoint only as context', () => {
  const vm = createViewModel();
  applyFrame(vm, { type:'response', command:'get_state', success:true, data:{ model:{ provider:'harness-local', id:'auto' } } });
  applyFrame(vm, { type:'selection', selection:{ model:{ id:'combo/main', decision_source:'remote_decision' } } });
  assert.deepEqual(resolvedModel(vm), { id:'combo/main', source:'원격 결정 모델', endpoint:'harness-local/auto' });
});

test('item 4: one header status per state', () => {
  assert.deepEqual(sessionStatus({ completed:true }), { state:'ready', text:'완료' });
  assert.deepEqual(sessionStatus({ busy:true, stage:'도구 실행 중' }), { state:'busy', text:'도구 실행 중' });
  assert.equal(sessionStatus({ problem:{ state:'error', text:'브리지 응답 없음' } }).text, '브리지 응답 없음');
});

test('item 6: one verification statement, never "none" next to "ran once"', () => {
  assert.equal(verifyStatement({ runs:0 }), null);
  assert.equal(verifyStatement({ runs:1, passed:1 }).text, '검증 1회 실행 · 통과 1');
  const unknown = verifyStatement({ runs:1 });
  assert.equal(unknown.state, 'unknown');
  assert.ok(unknown.text.startsWith('검증 1회 실행') && unknown.text.includes('결과 미수집'));
});

test('item 8: the sent prompt sorts before the answer even when the answer has no order yet', () => {
  const vm = createViewModel();
  addPendingPrompt(vm, '등록 버튼 색상을 바꿔 줘');
  applyFrame(vm, { type:'message_start', message:{ role:'assistant', content:'' } });
  applyFrame(vm, { type:'message_end', message:{ role:'assistant', content:'바꿨습니다' } });
  applyFrame(vm, { type:'message_start', message:{ role:'user', content:'등록 버튼 색상을 바꿔 줘' } });
  const roles = transcriptEntries(vm).filter(x => x.message).map(x => x.message.role);
  assert.deepEqual(roles, ['user','assistant']);
});

test('item 9: privacy line shows type, action and sent state and never a raw value', () => {
  const raw = '900101-1234567';
  const frame = { type:'privacy.masked', data:{ rules:['korean_rrn', raw], counts:{ korean_rrn:1 }, fields:['messages[0].content', raw], fingerprint:'a1b2c3d4', value:raw, original:raw } };
  const record = privacyRecord(frame, 1, 1);
  const line = privacyLine(record);
  assert.equal(line.text, '개인정보 보호 · 주민등록번호 1건 · 가명화 · 요청 전송됨');
  assert.ok(!JSON.stringify({ record, line }).includes(raw));
  const blocked = privacyLine(privacyRecord({ type:'privacy.blocked', data:{ rules:['provider_key'], counts:{ provider_key:2 }, code:'privacy_guard_blocked' } }, 2, 1));
  assert.equal(blocked.text, '개인정보 보호 · API 키 2건 · 차단 · 요청 보내지 않음');
  const review = privacyRecord({ type:'privacy.blocked', data:{ rules:['korean_rrn'], code:'privacy_guard_unverifiable_high_risk' } }, 3, 1);
  assert.equal(review.action, 'review');
});

test('item 9: exported document model sanitizes raw secrets and personal info', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const emptyModelRoot = mkdtempSync(join(tmpdir(), 'ui-cleanup-nomodel-'));
  t.after(() => {
    try { rmSync(emptyModelRoot, { recursive: true, force: true }); } catch {}
  });
  const { buildDocumentModel } = await import('../insight/document.mjs');
  const secret = 'sk-proj-superSecretLiveKey1234567890';
  // A checksum-valid 880101-1234568 (the trailing digit is the check digit) is what the RRN rule accepts.
  const rrn = '880101-1234568';
  const phone = '010-9876-5432';
  const events = [
    { type:'prompt', message:`목표: ${phone} 및 주민등록번호 ${rrn} 사용자 계정 정리`, ts:Date.now() - 5000 },
    { type:'tool_execution_end', result:{ details:{ path:'src/key.js', diff:`@@ -1 +1 @@\n-const key = "${secret}";\n+const key = process.env.KEY;` } }, ts:Date.now() - 1000 }
  ];
  const model = await buildDocumentModel({ type:'report', events, meta:{ sessionId:'audit-s1', title:'감사 보고서' }, modelRoot: emptyModelRoot, env: {} });
  const serialized = JSON.stringify(model);
  assert.ok(!serialized.includes(secret), 'Raw secret leaked into document projection');
  assert.ok(!serialized.includes(rrn), 'Raw resident number leaked into document projection');
  assert.ok(!serialized.includes(phone), 'Raw phone number leaked into document projection');
});
