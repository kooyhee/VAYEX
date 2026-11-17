// Labelled retrieval set for measuring the layer on this project's real vocabulary.
//
// The corpus is the kind of memory this repo actually produces (Korean instructions,
// English error text, code identifiers). Queries are paraphrases or cross-language
// rewrites of one target each, so recall@k / MRR measure semantics, not string overlap.
export const CORPUS = [
  {
    label: 'build-cmd',
    type: 'project-rule',
    title: '빌드는 bun run build로 실행한다',
    body: '이 프로젝트의 빌드 명령은 bun run build 이고, npm run build 는 사용하지 않는다.',
  },
  {
    label: 'stub-port',
    type: 'project-rule',
    title: '오프라인 스텁은 127.0.0.1:8799에서 뜬다',
    body: 'demo-chat 스텁 업스트림은 127.0.0.1:8799 포트의 loopback HTTP 서버이며 모델 이름은 demo-chat 이다.',
  },
  {
    label: 'korean-reply',
    type: 'user-preference',
    title: '응답은 한국어로 하고 존댓말을 쓴다',
    body: '사용자는 한국어 존댓말 응답을 선호하며, 코드 주석도 한국어로 단다.',
  },
  {
    label: 'no-commit',
    type: 'user-preference',
    title: '명시적 요청 없이 커밋하지 않는다',
    body: '이 저장소는 git 저장소가 아니며, 커밋/푸시는 사용자가 명시적으로 요청할 때만 한다.',
  },
  {
    label: 'rpc-launch',
    type: 'exploration-finding',
    title: 'RPC 실행 인자는 protocol.js의 launchArguments에 있다',
    body: "app/public/protocol.js:77 launchArguments(extra) 가 ['--mode','rpc',...extra] 를 만든다. app/server.mjs:398 이 spawn 으로 omp 자식을 띄운다.",
  },
  {
    label: 'fts-sanitize',
    type: 'exploration-finding',
    title: 'FTS5 질의는 fts5_memory.sanitize_fts5_query로 살균한다',
    body: 'engine/fts5_memory.py 의 sanitize_fts5_query 가 구두점을 제거하지 않으면 fts5: syntax error 가 난다.',
  },
  {
    label: 'port-in-use',
    type: 'error-fix',
    title: 'EADDRINUSE 8799는 이미 뜬 스텁을 종료해서 해결한다',
    body: 'Error: listen EADDRINUSE 127.0.0.1:8799 가 나면 이전 스텁 프로세스를 종료하고 다시 실행한다.',
  },
  {
    label: 'onnx-abi',
    type: 'error-fix',
    title: 'onnxruntime-node 로드 실패는 Node 버전 불일치 때문',
    body: 'onnxruntime-node 가 ORT_INVALID_ARGUMENT 로 실패하면 N-API 를 지원하는 Node 22 이상으로 실행한다.',
  },
  {
    label: 'prompt-cache',
    type: 'project-rule',
    title: '시스템 프롬프트는 턴마다 동일하게 유지한다',
    body: '메모리 블록은 세션 시작 시 한 번 고정하고 시스템 프롬프트 끝에 붙여 prefix 캐시를 깨지 않는다.',
  },
  {
    label: 'node-sqlite',
    type: 'exploration-finding',
    title: 'node:sqlite의 DatabaseSync로 FTS5를 쓴다',
    body: 'Node 26 내장 node:sqlite 는 FTS5 를 지원하며 DatabaseSync.prepare 로 MATCH 질의를 실행한다.',
  },
  {
    label: 'bun-runtime',
    type: 'exploration-finding',
    title: 'omp 자식 프로세스는 .omp-runtime의 bun 1.4.4로 실행된다',
    body: 'app/lib/localRuntime 이 .omp-runtime/node_modules/bun/bin/bun.exe 와 dist/cli.js 를 가리킨다.',
  },
  {
    label: 'embed-model',
    type: 'project-rule',
    title: '임베딩 모델은 Xenova/multilingual-e5-small을 쓴다',
    body: '로컬 임베딩은 multilingual-e5-small 384차원 모델을 CPU에서 q8 로 실행하며 모델 파일은 app/memory/data/models 에 둔다.',
  },
  {
    label: 'secret-guard',
    type: 'project-rule',
    title: '비밀키는 메모리에 저장하지 않는다',
    body: 'API 키, 개인키 블록, Bearer 토큰은 저장 전에 차단 또는 마스킹한다.',
  },
  {
    label: 'dedupe',
    type: 'project-rule',
    title: '가까운 중복 메모리는 병합하고 모순은 대체한다',
    body: 'Jaccard 0.72 이상 겹치는 메모리는 병합하고, 같은 주제의 새 값은 이전 값을 superseded 로 바꾼다.',
  },
  {
    label: 'test-run',
    type: 'past-task',
    title: '메모리 테스트는 node --test로 실행했다',
    body: 'app/memory/test/*.test.mjs 를 node --test 로 실행해 저장소·검색·가드 동작을 검증했다.',
  },
  {
    label: 'benign-build-fail',
    type: 'failure-analysis',
    title: 'TypedRow 타입 오류로 빌드가 실패했다',
    body: 'TypeScript 빌드에서 Type error: Property id does not exist on type TypedRow 가 발생했다.',
  },
  {
    label: 'gateway-route',
    type: 'exploration-finding',
    title: '게이트웨이는 x-route 헤더로 세션 경로를 고정한다',
    body: 'gateway/lib/policy.mjs 의 enforceRoute 가 x-route 헤더와 세션 경로가 다르면 403 session_route_mismatch 를 낸다.',
  },
  {
    label: 'korean-token',
    type: 'exploration-finding',
    title: '한국어는 음절 bigram 토큰으로 부분 일치를 만든다',
    body: 'FTS5 unicode61 은 한국어 조사를 붙여 한 토큰으로 만들기 때문에 음절 bigram 을 함께 색인한다.',
  },
];

export const QUERIES = [
  { q: '빌드 어떻게 실행해?', expect: ['build-cmd'] },
  { q: 'how do I build this project?', expect: ['build-cmd'] },
  { q: '스텁 서버 포트가 몇이야', expect: ['stub-port', 'port-in-use'] },
  { q: 'demo-chat model endpoint', expect: ['stub-port'] },
  { q: '답변 언어 설정', expect: ['korean-reply'] },
  { q: '한국어로 대답해줘', expect: ['korean-reply'] },
  { q: '커밋해도 돼?', expect: ['no-commit'] },
  { q: 'RPC 모드로 omp를 어떻게 띄우지', expect: ['rpc-launch'] },
  { q: 'FTS5 syntax error 원인', expect: ['fts-sanitize', 'korean-token'] },
  { q: '포트가 이미 사용 중이라고 나온다', expect: ['port-in-use'] },
  { q: 'onnxruntime node failed to load', expect: ['onnx-abi'] },
  { q: 'prompt caching 깨지지 않게 메모리 주입하는 법', expect: ['prompt-cache'] },
  { q: 'sqlite fts5 를 node 에서 쓰는 방법', expect: ['node-sqlite'] },
  { q: 'bun 바이너리 위치', expect: ['bun-runtime'] },
  { q: '어떤 임베딩 모델 써?', expect: ['embed-model'] },
  { q: 'secrets in memory', expect: ['secret-guard'] },
  { q: 'duplicate memories merge', expect: ['dedupe'] },
  { q: 'memory tests how to run', expect: ['test-run'] },
  { q: 'TypedRow property error', expect: ['benign-build-fail'] },
  { q: 'x-route header mismatch 403', expect: ['gateway-route'] },
];
