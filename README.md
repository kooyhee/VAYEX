# 로컬 통합 AI 코딩 하네스 : VAYEX — 개발자 안내서

> **"로컬 환경에서 안전하고 경제적인 지능형 코딩 하네스"**  
> **공식 대회 등록 작품명:** 로컬 통합 AI 코딩 하네스 : VAYEX  
> **제품 브랜드명:** **VAYEX (바엑스)**  
> **부제:** 로컬 통합 AI 코딩 하네스

**본 저장소는 로컬 하네스(`omp`), 추론/정책 게이트웨이(`gateway/`), 장기 메모리(`app/memory/`), 개발자 경험(DX) 계층(`app/dx/`), 오케스트레이터(`app/orchestrator/`), 전송 전 프라이버시 가드(`app/privacy/`), 웹 워크벤치 UI(`app/public/`)를 단일 호스트 프로세스 아래 통합한 개발 플랫폼입니다.**

부스 시연의 영상 각본과 화면 순서는 `시연_영상_시나리오.md`에 정리되어 있습니다. 이 각본을 파일로 만드는 파이프라인은 `output/demo/`에 있습니다: `render.py`가 `scenes.final.json`의 장면 spec을 렌더링하고, 샷 목록과 화면 허용 숫자는 `shotlist.md`에 있습니다. 완성 마스터는 `output/demo/demo.16x9.mp4`(1920x1080)와 `output/demo/demo.9x16.mp4`(1080x1920)이며, 둘 다 60.000초·30 fps·H.264 High·faststart·오디오 없음·끊김 없는 루프이고 포스터 4장(`output/demo/poster.16x9.png`, `poster.16x9.card.png`, `poster.9x16.png`, `poster.9x16.card.png`)이 함께 있습니다. 렌더링 후 자체 검증 **255개 통과 / 0개 실패**를 마쳤고, 초기 독립 리뷰가 지적한 결함 3건(9:16 전환 구간의 두 패널 동시 노출, S7 자막의 루프 페이드 침범, 9:16 S3 헤더와 env 태그 겹침)은 재렌더링으로 수정한 뒤 검사기 항목으로 고정했습니다. 재렌더링·spec·화면 문구 규칙은 `output/demo/README.md`에 있습니다.

루트 실행 진입점(`launch.cmd` / `launch.ps1`)은 `omp` 런타임을 기동합니다. `-Runtime` 값은 `omp`만 받으며, 그 밖의 값은 명확한 오류와 함께 중단합니다.

| 런타임 | 기동 방법 | 구성 및 동작 개요 |
| --- | --- | --- |
| `omp` — **로컬 하네스** | 루트 `launch.cmd` / `launch.ps1` (기본값), 또는 `app\launch.cmd` | `.omp-runtime\`에 내장된 Bun 기반 oh-my-pi `18.16.0`을 자식 프로세스로 실행하고, Node.js 기반 로컬 실행 환경(HTTP/WebSocket 브리지)이 이를 감쌉니다. 브리지는 작업 실행, 대화, 코드 리뷰, 실시간 웹 미리보기, 세션 리포트 시각화를 단일 작업 공간(`app\public\`)으로 제공합니다. 게이트웨이 라이브러리를 인프로세스로 직접 임포트하여 OpenAI 호환 추론 엔드포인트(`/v1/chat/completions`, `/v1/models`, `/v1/selection`, `/healthz`), DX API(`/api/dx/*`), 메모리 API(`/api/memory/*`), 로컬 인사이트 API(`/api/insight/*`), 세션 시각화 문서 생성기(`/api/visualize/html?session=&type=`, `/api/visualize/pdf?session=&type=`, `/api/visualize/list`)를 동일한 루프백 포트에서 서빙합니다. 상세 동작: `app/README.md`. |

저장소의 주 개발 대상은 `app/` 및 `gateway/`에 구현된 통합 로컬 하네스 시스템입니다.

**로컬 환경 현황:** Node.js `v26.13.0`, npm `12.0.2` 설치됨. `omp` 코어는 `.omp-runtime\` (`node_modules\bun\bin\bun.exe`, `node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js`)에 설치되어 있어 별도 다운로드 없이 즉시 기동됩니다.

---

## 저장소 구성 요소 및 디렉터리 구조

| 경로 | 역할 및 상세 |
| --- | --- |
| `launch.cmd` / `launch.ps1` | 루트 기동 진입점. `omp` 런타임을 기동하며, `-Runtime`에 다른 값을 주면 명확한 오류로 중단합니다. |
| `app/` | 로컬 하네스 호스트: Node.js 브리지 서버(`server.mjs`), 인프로세스 추론 서피스(`lib/inference.mjs`), 웹 UI 리소스(`public/`), 통합 테스트 suite. |
| `app/memory/` | **장기 메모리 계층**: 로컬 임베딩(`Xenova/multilingual-e5-small`), SQLite FTS5 + 벡터 하이브리드 검색(RRF 융합), 6대 메모리 유형 관리, 비밀값 마스킹/프롬프트 주입 격리, OMP 확장(`extension.mjs`). |
| `app/dx/` | **개발자 경험(DX) 계층**: 프로젝트 스택 자동 감지, Git 독립형 스냅샷/Diff/되돌리기, 자동 검증(auto-verify), 한국어 오류 해설, 작업 재개(task resume), 비용 분석. `/api/dx/*`로 노출. |
| `app/orchestrator/` | **에이전트 오케스트레이터**: 파일 충돌 락, 의존성 DAG 스케줄링, 병렬 이득 임계치(`MIN_PARALLEL_GAIN = 1.15`), 모델 단계적 격상(escalation), 부분 재계획(partial replan), 로컬 전용 백그라운드 작업. |
| `app/privacy/` | **전송 전 프라이버시 가드**: 탐지 카탈로그(`detectors.mjs`), 가명 저장소(`vault.mjs`), 전송 게이트(`gate.mjs`), 선택 SLM 단계(`slm.mjs`) 등 7개 모듈. 대화·도구 결과·첨부·이미지/영상 프롬프트·메모리 주입/저장·문서 내보내기·진단 로그가 같은 게이트를 지납니다. |
| `app/omp/` | OMP 런타임 확장 모듈: RTK 스타일 무손실 도구 출력 컴팩션(`bounded-tool-result.js`), 20KB 초과 디스크 스필 스토어. |
| `gateway/` | 인프로세스 게이트웨이 라이브러리: 허용 목록(`allowlist.mjs`), 경로 정책(`policy.mjs`), 세션 핀(`session-pin.mjs`), TurnPlan 검증기(`turn-plan.mjs`), 3단계 프롬프트 캐시 레이어링(`prompt-cache.mjs`), 단가표(`cost-rates.mjs`). |
| `booth/` | **경진대회 부스 시연 키트**: 예제 프로젝트(`sample-project`), 약 1.1초 원클릭 바이트 단위 멱등 원상복구 스크립트(`reset.ps1`), 부스 운영자 카드(`README.md`), (A) 상시 영상 + (B) 현장 실작업 세션 운영 자료. |
| `.omp-runtime/` | 기설치된 Bun 런타임 및 oh-my-pi 코어 패키지. |
| `packaging/customization/` | `catalog.json`(모델 라우팅 메타데이터) 및 생성기(`generate_catalog.py`). |
| `scripts/` | 벤치마크 러너(`benchmark-4env.mjs`, `benchmark-comparison.mjs`, `benchmark-live-*.mjs`), 공용 라이브러리(`lib/`), 픽스처·시드 스크립트. |
| `output/demo/` | **부스 시연 영상 파이프라인**: `render.py`(장면 spec → 16:9·9:16 마스터), `scenes.final.json`(10장면), `shotlist.md`(샷 목록·화면 허용 숫자), `shots/`(장면 캡처), 빌드 로그, 완성 마스터 2종과 포스터 4장. 운영 안내: `output/demo/README.md`. |
| `engine/`, `harness/`, `prototype/` | 초기 Python 엔진 및 Tkinter 프로토타입. `omp` 실행 경로에는 연결되지 않음. |

---

## 핵심 서브시스템 상세

### 1. 장기 메모리 계층 (`app/memory/**`)

세션을 초과하여 프로젝트 규칙, 과거 작업 내역, 오류 해결책을 보존하고 적응적으로 주입하는 서브시스템입니다.

- **임베딩 파이프라인**: 로컬 ONNX 기반 `Xenova/multilingual-e5-small` (45 MB, q8 양자화, 384 차원 벡터). `@huggingface/transformers` 통합 인프로세스 런타임에서 구동되며, 오프라인/테스트 환경용 `local-hash-3gram-v1` 스텁을 포함하여 외부 임베딩 API를 일체 호출하지 않습니다.
- **하이브리드 검색 및 융합**: SQLite FTS5 전문 검색(`memories_fts`)과 인메모리 `Float32Array` 코사인 유사도 벡터 검색을 Reciprocal Rank Fusion (RRF, k=60)으로 융합합니다. 최종 점수는 관련도(0.55), 중요도(0.20), 시간 감쇠(0.15, 반감기 45일), 프로젝트 일치도(0.10) 가중치를 반영합니다. HTTP 라우터와 에이전트 확장이 동일한 단일 SQLite 데이터베이스(`data/memory/memory.db`)를 공유합니다.
- **6대 메모리 유형 (`MEMORY_TYPES`)**:
  1. `user-preference`: 사용자 작업 방식 및 도구 선호도
  2. `project-rule`: 빌드/테스트 규칙, 코딩 컨벤션
  3. `past-task`: 이전 세션의 주요 작업 맥락 및 결과
  4. `error-fix`: 발생한 오류 시그니처와 검증된 해결 방법
  5. `exploration-finding`: 탐색 중 확인된 아키텍처/의존성 분석 결과
  6. `failure-analysis`: 반복 실패한 시도와 회피 지침
- **저장 및 이력 관리**: 삭제 없는 추가 전용 소프트 폐기(append-only soft deprecation). 신규 버전 생성 시 이전 레코드는 `superseded`로 표시되고 `version`이 증가합니다. 자카드(Jaccard) n-gram 핑거프린트 유사도 0.72 이상 시 중복을 제거하고 적중 횟수(`dedupe_hits`)를 갱신합니다. 변경 내역은 `memory_audit` 테이블과 `audit.jsonl`에 기록됩니다.
- **보안 가드 및 주입 격리 (`guard.mjs`)**:
  - 비밀값 감지: API 키(OpenAI, Anthropic, AWS 등), Bearer 토큰, 비공개 키 블록(`BEGIN PRIVATE KEY`), 고엔트로피 문자열을 자동 마스킹 또는 저장 거부합니다.
  - 프롬프트 주입 격리: 주입/지침 무시 구문 탐지 시 최하위 신뢰 등급으로 강등하고 `injection_flag=1`로 격리(Quarantine)합니다. 격리된 메모리는 프롬프트 컨텍스트 주입 대상에서 완전 제외되며 API 조회만 허용됩니다.
  - 출처 검증(Provenance): `session_id`, `source_event`, `source_kind`, 타임스탬프가 없는 메모리 생성 요청은 즉시 거절됩니다.
- **컨텍스트 블록 주입 및 도구 연동**:
  - `renderMemoryBlock`: 상위 3~5개 항목, 최대 1,600자 제한으로 결정론적 주입 블록을 생성합니다. 세션 시작 시 한 번 고정(frozen)되어 접두사 캐시(KV Cache) 무결성을 유지합니다.
  - `memory_search` 도구: 에이전트가 능동적으로 메모리를 질의할 수 있는 도구를 제공합니다.
  - OMP 확장(`extension.mjs`): 세션 라이프사이클 이벤트(`session_start`, `before_agent_start`) 및 도구 실행 결과를 감지하여 메모리를 자동 수집합니다.

### 2. 비용 및 속도 최적화 계층 (`gateway/lib/**`, `app/orchestrator/**`, `app/omp/**`)

토큰 소모량과 지연 시간을 최소화하기 위해 다단계 비용 최적화 파이프라인과 엄격한 실행 정책을 강제합니다.

- **비용 최적화 4단계 파이프라인 (Cost Optimization Pipeline)**:
  1. **도구 출력 컴팩션 및 디스크 스필 (Tool Output Compaction & Spill >20KB, `app/omp/bounded-tool-result.js`)**:
     - ANSI 제어 코드 제거 및, 테스트/빌드 로그 형식이고 8줄을 넘으며 에러가 없을 때에 한해, 3회 이상 연속 중복 라인 축약(`... [이전 줄 N회 중복 반복 생략] ...`). 일반 데이터(CSV·반복 픽스처·페이징 덤프)는 원본 바이트 그대로 전달합니다.
     - 에러가 없는 50줄 초과 빌드/테스트 성공 로그의 중간부를 생략하고 상단 15줄과 하단 15줄 보존(에러 트레이스 발생 시에는 원본 전체 보존).
     - 20KB(`CEILING_BYTES`) 초과 대형 출력은 `spillStore`에 원본을 보관하고 `spill://<id>` 복구 핸들을 포함하는 요약 노티스로 대체하여 컨텍스트 토큰 폭증을 방지하고 무손실 복구를 지원. 노티스가 지시하는 `tool_output_recover` 도구는 확장이 `pi.registerTool`로 실제 등록하며(`app/omp/bounded-tool-result.js:283`), 핸들과 `offset`/`limit`을 받아 스필 원본을 그대로 반환합니다. 네이티브 아티팩트(`artifact://<n>`)는 이 스토어의 핸들이 아니라 런타임 `read` 도구가 해석하는 별도 경로이며, 노티스는 그 경우 경로/원시 선택자를 안내합니다.
  2. **세션 모델 고정 (Session Model Pinning, `gateway/lib/session-pin.mjs`)**:
     - 세션 및 작업 세그먼트 단위(`x-app-session`)로 모델 및 추론 설정을 고정. 기본 TTL은 공급자 캐시 유지 시간인 5분(300,000ms)이며 유휴 상태에서는 갱신되지 않고 만료.
     - 턴마다 모델이 빈번히 교체되어 KV 캐시가 무효화되는 현상을 방지하고 세션 연속성을 보장.
  3. **규칙 기반 2트랙 라우터 (Rule-based 2-Track Router, `gateway/lib/decision-planner.mjs`, `gateway/lib/selection.mjs`)**:
     - **구현 및 실시간 연동**: 정규식 및 키워드 기반 결정론적 복잡도 분석을 통해 단순 작업(`direct_execute`, thinking budget 0, 고속 모델 `fast`)과 복합 작업(`survey_and_plan`, 조사→계획→구현→검증 4단계 지침, thinking budget 4096, 고지능 모델 `high_intelligence`)을 외부 LLM 호출 비용 0원으로 분기합니다. `app/lib/inference.mjs`의 실시간 요청 모델 결정 경로(`resolveRequestModelWithPolicy`)에 직접 연결되어 작동합니다.
     - **의사결정 모델 위임 (Decision Model Delegation)**: 실제 서빙 모델의 선택은 원격 결정 모델(`combo/*` 경로)에 위임되고, 운영자 게이트웨이가 자체 결정 엔진으로 작업 모델을 해석합니다. 원격 결정 계층에 도달할 수 없거나 로컬 전용으로 고정된 턴은 아래 3절의 선언된 로컬 체인으로 폴백합니다.
  4. **3단계 프롬프트 접두사 캐싱 (L1/L2/L3 Prompt Caching, `gateway/lib/prompt-cache.mjs`)**:
     - `Level 1 (정적)`: 시스템 지침 및 도구 스키마(키 정렬 정규화 `canonicalizeTools`). 세션 전체에서 바이트 단위 불변 유지.
     - `Level 2 (반정적)`: 프로젝트 규칙 및 장기 메모리 주입 블록. 메모리 갱신 시에만 변경.
     - `Level 3 (동적)`: 대화 이력 및 현재 사용자 턴.
     - 공급자 캐시 제어: Anthropic의 경우 Level 1/2 경계에 `cache_control: {type: 'ephemeral'}`을 자동 배치하며, OpenAI의 경우 호환 모델에 안정된 `prompt_cache_key`를 전달하여 KV Cache 적중률을 극대화.
- **TurnPlan 정책 검증기 (`gateway/lib/turn-plan.mjs`)**: 에이전트의 실행 계획을 V-01부터 V-08까지의 규칙으로 엄격 검증 및 클램핑합니다.
  - `V-01` (Track): `direct_execute` 또는 `survey_and_plan`
  - `V-02` (Tier): `fast` (직접 실행) 또는 `high_intelligence` (조사/계획)
  - `V-03` (Thinking Budget): 직접 실행 시 0, 계획 모드 시 1~8192 토큰
  - `V-04` (Workers): 직접 실행 시 1, 계획 모드 시 2~4 워커
  - `V-05` (Directive): 직접 실행 시 null, 계획 모드 시 2,000자 이하 지침
  - `V-06` (Model): 게이트웨이 허용 목록(allowlist) 내 모델 여부
  - `V-07` (Reasoning): 추론 강도(`low`/`medium`/`high`)와 생각 예산 일치 여부
  - `V-08` (Budget): 실행 예산 상한선 초과 시 직접 실행으로 안전 격하
- **에이전트 오케스트레이터 (`app/orchestrator/orchestrator.mjs`)**:
  - 파일 충돌 방지: 동일 파일을 참조하는 복수 태스크의 동시 실행 차단.
  - 의존성 DAG: 선행 작업이 완료(`completed`)된 태스크만 큐에서 해제.
  - 병렬성 이득 임계치: 순차 실행 추정 시간 대비 병렬 실행 시간이 15% 이상 단축될 때만(`seqMs / parMs >= 1.15`) 병렬 실행 허용.
  - 모델 격상 및 부분 재계획: 실패 반복 시 `tier-1-fast` → `tier-2-medium` → `tier-3-smart`로 모델을 단계적 격상하며, 최대 재시도 소진 시 실패 태스크와 직간접 의존 작업만 차단하고 독립 태스크는 계속 진행.
- **로컬 전용 백그라운드 처리 (`app/insight/**`, `gateway/lib/local-background.mjs`)**:
  - **백그라운드 작업은 기기 안에서 끝납니다**: 세션 제목, 작업 일지 요약, 다이제스트, 메모리 정리, 임베딩, 인덱싱, 검색은 외부 LLM을 호출하지 않습니다(외부 호출 0회). 임베딩과 토크나이즈는 번들된 다국어 임베딩 모델과 토크나이저가 인프로세스로 처리하며, 별도 Python 환경이나 별도 서버 프로세스를 띄우지 않습니다.
  - **저우선순위 실행기 측정**: 저우선순위 큐 실행기(`runLowPriority`)는 20개 작업 단위를 2.17 ms에 처리하고 RSS 증가는 +1.38 MB였습니다. 이 수치는 `app/insight/test/local-model.test.mjs:90-107`의 합성 워커 측정이며, 실행기 자체의 오버헤드를 재는 값입니다(모델 생성 시간이 아닙니다).
  - **백그라운드 SLM은 미설치 후보**: 레지스트리(`app/insight/local-model.mjs:REGISTRY`)는 문서와 `app/privacy/slm.mjs:SLM_CANDIDATES`가 말하는 후보 두 개, 즉 기본 `Qwen2.5-0.5B-Instruct`(q4f16, 461 MB ONNX)와 고품질 대안 `Qwen3.5-0.8B`(q4f16, 520 MB ONNX)입니다. 두 가중치 모두 이 머신에 설치되어 있지 않아(설치된 모델은 113 MB 임베딩 ONNX 하나) **성능·품질 모두 미측정**입니다. 후보를 설치하면 `createLocalGenerator`가 transformers.js 런타임으로 로컬 추론을 수행해 요약 단계가 `local-model` 계층으로 전환되고, 설치하지 않은 상태에서는 결정론적 규칙 계층이 그대로 동작합니다.
  - **필수 계층은 SLM과 무관하게 항상 동작**: 전송 전 개인정보 가드는 SLM이 없더라도 정규식·검증(체크섬) 계층을 반드시 수행하고, 위험도가 높은데 검증할 수 없는 전송은 차단합니다. SLM 단계는 이 위에 얹히는 선택 단계이며 상한이 정해져 있습니다.
  - **관찰 가능 워치독 (Observable Watchdog, `app/insight/watchdog.mjs`)**:
    - 모델 호출이나 네트워크 해석 없이 순수 런타임 수신 신호(RPC 프레임 도착 시각, 하트비트 프레임, `tool_execution_start`/`end`, 진행 상태 전이, 터미널 프레임)의 타임스탬프만을 대조하여 에이전트의 멈춤/무한 로딩(infinite-loading / stall) 상태를 객관적으로 판별합니다.
    - `GET /api/insight/watchdog` 및 `GET /api/insight/metrics`를 통해 상태를 실시간 노출합니다.
  - **벤치마크 오케스트레이션**: 벤치마크 러너(`gateway/bench/run-benchmark.mjs`)에서 `--profile both` 플래그를 통한 baseline 및 optimized 순차 실행 오케스트레이션을 결함 없이 지원합니다.

### 3. 역할 라우팅과 모델 결정 (`gateway/lib/**`, `app/lib/inference.mjs`)

턴마다 "어느 역할이 이 작업을 맡는가"와 "어느 모델이 이 역할을 서빙하는가"를 두 단계로 나누어 정합니다. 앞 단계는 로컬에서 끝나고, 뒤 단계는 원격 결정 모델에 위임됩니다.

- **역할 여섯 가지와 로컬 분류**: `main`(조율), `planner`(계획), `frontend`, `backend`, `research`, `verifier`. 턴의 역할 분류는 로컬 하네스가 스스로 수행하며 외부 호출을 동반하지 않습니다. 역할을 명시하지 않은 턴은 `main`으로 분류됩니다.
- **모델 결정은 원격 결정 모델에 위임**: 역할이 정해지면 하네스는 모델 선택을 원격 결정 모델에 맡깁니다. OpenAI 호환 TLS 엔드포인트로 `combo/advisor`, `combo/front-worker`, `combo/lead`, `combo/worker`, `combo/writer`, `combo/heavy-worker`, `combo/reviewer`, `combo/security`와 `infron/qwen/qwen3.8-27b:free`를 호출하고, 운영자가 운용하는 게이트웨이가 자체 결정 엔진(**Nace** 공급자, **DrexMax v1.1**, effort max)으로 실제 작업 모델을 해석합니다. 이 목록은 업스트림이 실제로 서빙하는 `GET /v1/models` 결과와 일치하며, 역할 없이 분류된 `main` 턴도 같은 방식으로 원격 결정 모델에 도달합니다.
- **폴백의 조건과 보고 위치**: 원격 결정 평면에 도달할 수 없거나 요청이 로컬 전용으로 고정된 경우, 하네스는 선언된 로컬 체인으로 폴백하고 그 사실을 응답 본문, `x-gateway-decision-*` 응답 헤더, `/v1/selection`, 컴포저 칩에 함께 보고합니다. 폴백은 조용히 일어나지 않으며, 인증 실패와 네트워크 도달 불가는 같은 보고 경로에서 서로 다른 사유로 구분됩니다.
- **백그라운드 작업의 경계**: 임베딩, 인덱싱, 검색, 제목 생성, 타임라인, 진행 상태 집계 등 백그라운드 작업은 외부 LLM을 호출하지 않습니다.
- **설계 의도**: 역할 분류와 모델 결정이 한 지점에 모이면, 설정과 비용을 다루는 사람이 도구마다 같은 일을 반복하지 않게 됩니다.
- **측정 현황**: Claude Opus 5.5와 VAYEX 하네스 두 환경을 대상으로 한 실측 비교가 완료되었습니다. 측정 환경·통과 수·비용은 아래 '실측 2환경 비교' 절과 `output/benchmark-live-2env-official-report.md`에 있습니다.

### 4. 개발자 경험(DX) 계층 (`app/dx/**`)

개발 주기 단축과 안전한 코드 수정을 위한 서비스 모듈 집합으로, Node.js 기반 로컬 실행 환경(`/api/dx/*`) 엔드포인트를 통해 접근합니다.

- **프로젝트 스택 자동 감지 (`app/dx/project-detect.mjs`)**: Node.js/TypeScript (Next.js, pnpm 등), Python (FastAPI, pytest), Rust (Cargo, Axum), Go, Java (Gradle) 등을 식별하고 테스트/빌드 명령을 추출합니다 (`GET /api/dx/project/detect`).
- **Git 독립형 스냅샷 및 Diff 제어 (`app/dx/snapshot-diff.mjs`)**: Git 저장소 없이도 수정 전 파일 상태를 스냅샷으로 보존하고, 작업 단위 Diff(`/api/dx/snapshot/diff`), 파일별 되돌리기(`/api/dx/snapshot/revert`), 작업 전체 되돌리기(`/api/dx/snapshot/rollback`)을 제공합니다. 파일 변경 검토에는 승인 단계가 없고 확인과 되돌리기만 있습니다.
- **자동 검증 (`app/dx/auto-verify.mjs`)**: 감지된 테스트/빌드 명령을 제한시간 내 실행하고 결과를 한국어 요약으로 반환합니다 (`POST /api/dx/verify/run`; 타임아웃 시 프로세스를 종료하고 실패로 보고).
- **한국어 오류 해설기 (`app/dx/korean-error-explainer.mjs`)**: 7대 주요 에러 범주(구문 오류, 모듈 누락, 타입 불일치, 테스트 단언 실패, 타임아웃, 권한 부족, 네트워크 단절)를 분류하고 원인과 조치를 평이한 한국어로 설명합니다 (`POST /api/dx/explain-error`).
- **작업 상태 재개 (`app/dx/task-resume.mjs`)**: 중단된 작업의 프롬프트, 상태, 메모리 훅을 저장·복원합니다 (`/api/dx/tasks/save`, `/api/dx/tasks/get`, `/api/dx/tasks/list`, `/api/dx/tasks/interrupt`, `/api/dx/tasks/resume`).
- **비용 분석기 (`app/dx/cost-analytics.mjs`)**: 로컬 오프로딩 절감액, 프롬프트 컴팩션, 캐시 적중률을 USD 및 KRW로 집계합니다 (`POST /api/dx/cost/event`, `GET /api/dx/cost/task`, `GET /api/dx/cost/overview`).

### 5. 웹 워크벤치 UI (`app/public/**`)

단일 브라우저 화면에서 작업 지시, 실시간 검토, 시각적 산출물 생성을 동시에 수행하는 **VAYEX (바엑스)**의 프론트엔드 작업 공간입니다.

- **테마 스튜디오(Theme Studio) & 7종 큐레이션 프리셋 (`#theme-toggle`, `app/public/app.js`)**:
  - Linear 스타일의 7종 테마 프리셋 제공:
    1. **옵시디언 다크 (Obsidian Dark, 기본값)**: 차분하고 깊은 다크 표면
    2. **소프트 데이라이트 (Soft Daylight)**: 따뜻하고 깨끗한 고대비 라이트
    3. **오로라 글로우 (Aurora Glow)**: 에메랄드·시안·바이올렛 오로라 무드
    4. **라벤더 미스트 (Lavender Mist)**: 섬세한 파스텔 라벤더·로즈 무드
    5. **코랄 선셋 (Coral Sunset)**: 따뜻한 피치·앰버 그라데이션
    6. **마리타임 보야지 (Maritime Voyage)**: 해양대 특화 심해 네이비와 파도 일러스트
    7. **하이 콘트라스트 (High Contrast)**: WCAG AAA 표준을 만족하는 최고 시인성 고대비
  - **배경 강도 & 표면 불투명도 슬라이더**: 슬라이더로 배경 레이어와 읽기 표면의 대비를 조정하며 설정값은 `localStorage`에 영구 보존됩니다.
- **인스펙터 3모드 제어 (Inspector 3-Mode Control, `#insp-expand`, `#insp-fullscreen`)**:
  - **접기(Collapse)**: `0px` (`body[data-inspector=closed]`)로 인스펙터를 닫고 대화/작업 공간을 극대화
  - **확장(Expand)**: `600px` (`body[data-inspector-mode=expanded]`, `--col-inspector: min(600px, 46vw)`) 너비로 코드 검토 및 문서 확인
  - **전체 화면(Fullscreen)**: 뷰포트 100% 전면 레이어(`body[data-inspector-mode=fullscreen]`, `position: fixed; inset: 0; z-index: 85`)로 인스펙터를 확장하여 대형 보고서 및 시각화 산출물 집중 열람
- **인스펙터 패널 수직 1글자 줄바꿈 버그 해소**:
  - 좁은 열 폭에서 한국어 조사가 분리되어 1글자씩 세로로 꺾여 내려가던 문제를 전역 `body { word-break: keep-all; }`, 패널 내 `min-width: 0`, `overflow-wrap: break-word`, 모노스페이스/코드 경로 요소의 `word-break: normal` 규칙으로 해결했습니다.
- **3분할 반응형 리사이징 레이아웃 (드로어 3건·전환 입력 결함 독립 수용 완료 · 실제 200% 줌 미검증)**:
  - **독립 수용된 부분**: `1180px` 이상 데스크톱의 좌측 사이드바 `260px`·우측 인스펙터 `364px` 정확 비율 레이아웃(분할 드래그 핸들 `#split-sidebar`, `#split-inspector` 클램핑 포함)과 브레이크포인트 이하(`320px` 및 `640 CSS px` 등가 확인) 좁은 화면의 **가로 넘침 없음**은 독립 수용되었습니다. 실제 브라우저 `200%` 줌은 **미검증**입니다. 격리된 Edge에서 두 번 시도했으나 모두 **도구 사유로 실패**했습니다(175%까지 도달한 뒤 최종 줌 입력이 `user_input_active`로 끝났고, 이후 격리 Edge는 조기 종료). 따라서 `320px`/`640 CSS px` 등가가 **유일한 레이아웃 근거**이며 `200%`에서의 사용성은 주장하지 않습니다.
  - **드로어 3건 수정(독립 수용 완료 — 저장된 구현·회귀 검사 및 작성자 통과 재사용)**: 이전 독립 셸 리뷰에서 지적된 드로어 결함 3건(① `Shift+Tab` 시 스킵 링크로 포커스 이탈, ② 드로어 닫힘 후 `fullscreen` 인스펙터 잔류, ③ 사이드바 검색·메모리 목적지 숨김/`inert`)은 독립 셸 리뷰어가 저장된 구현과 회귀 시험을 검토하고 기존 작성자 통과치(`frontend-native-keyboard` **6/6** + 기타 **17/17** = **23/23**, 전환 수정 후 **7/7** + **17/17** = **24/24**; 브라우저 **63/63**, 서버 정합 **5/5**)를 재사용하여 **독립 수용 완료**했습니다(신규 재실행·실시간 라이브 재현은 수행하지 않음).
  - **전환 입력 결함 수정(독립 수용 완료 — 신규 리뷰어가 구현·시험 타당성 수용)**: 원인은 스코프된 **ViewTransition 기반 전환**이 전환 중 인스펙터의 히트 테스트를 잃는 것이었고, 그 의미론을 폐기하고 **`Element.animate` 180ms 불투명도·6px 이동의 장식용 수신 패널 전환**으로 대체했습니다. 상태·ARIA·포커스 동기화는 즉시 반영되고 `prefers-reduced-motion` 및 API 부재 시 폴백은 유지됩니다. 회귀 시험은 **실제 앱 애니메이션을 20초로 늘린 상태에서** 실제 터치 스터디와 마우스 스펙이 **동작 중 통과**함을 확인합니다. 신규 리뷰어가 구현과 시험 타당성을 **독립 수용**했고 통과치는 저장된 실행을 재사용했습니다(재실행 없음): 프론트엔드 Node **24/24**(`frontend-native-keyboard` **7/7** + 기타 **17/17**), 브라우저 회귀 **63/63**, 서버 정합 **5/5**. 이로써 프론트엔드의 알려진 입력 결함은 해소되었으나 **제품 전체 검증이 완료된 것은 아닙니다**(실제 `200%` 줌은 별도로 열려 있음). 힌트 팝오버(`aria-describedby`)와 인스펙터 컨테이너 쿼리(`<=340px` / `>=470px`) 구현은 그대로 유지됩니다.
- **AI 작업 일지 (Work Timeline / AI Work Journal, `activity.js`, `insight.js`)**:
  - 도구 실행 로그의 단순 나열을 지양하고, AI 작업별 **추가/수정/삭제 카테고리 목적과 결과 중심의 1~2줄 요약(one-liners)**을 실시간 제공합니다.
  - 로컬 SLM 또는 규칙 기반 엔진으로만 로컬에서 안전하게 생성되며 외부 LLM 호출은 절대 발생하지 않습니다. 카테고리별 실시간 건수 배지 및 아코디언 접기/펼치기를 지원합니다.
- **산출물 문서 생성기 (Deliverable Document Generator, `session-report.js`, `app/server.mjs`)**:
  - 세션 전체 맥락과 엔지니어링 산출물을 4대 핵심 문서 유형으로 즉시 렌더링:
    1. **`report` (작업 결과 보고서)**: 종합 실행 내역, 코드 변경, 검증 결과
    2. **`study` (선행 연구·기술 검토)**: 채택 기술, 대안 비교, 기술 분석
    3. **`spec` (시스템 아키텍처 명세서)**: 모듈 인터페이스, 게이트웨이 및 메모리 명세
    4. **`summary` (경영진·심사위원 1장 요약)**: 문제 해결 핵심 및 정량·정성 성과
  - **동일 요청 재사용 (Content-Addressed Artifacts, `app/insight/document.mjs` `contentHashFor`)**: 문서 정체성은 세션 식별자 + 문서 유형 + **렌더링된 투영(projection)의 해시**로 정해집니다(`documentKey = sessionId:type:contentHash`). 같은 요청은 같은 문서를 다시 쓰지 않고 재사용하며, 탭을 열거나 미리보기를 여는 것만으로는 아무 문서도 생성되지 않습니다. 세션에 내용이 없으면 문서를 만들지 않고, **내용이 달라져야만 새 버전이 생깁니다**(생성 시각은 해시 대상에서 제외).
  - **정본 문서 한 세트**: 배포하는 정본은 `공학작품경진대회_작품개발보고서` 계열의 HTML/PDF와 표지 PNG 한 세트입니다. 중복 이름의 `작업개발보고서` 파일은 보관용으로만 남깁니다.
  - **단독 HTML · 헤드리스 PDF (`/api/visualize/pdf?session=&type=`)**:
    - 외부 CDN 의존성 없는 단독 Self-contained HTML 파일 제공.
    - Chromium/Edge 헤드리스 엔진을 직접 구동한 실제 고해상도 PDF 실시간 생성 및 다운로드.
    - 생성된 문서 목록 조회(`/api/visualize/list`), 워크벤치 내 iframe 미리보기, 새 창 열기, 단독 파일 내보내기/저장 지원.
  - **내보낸 다이어그램의 텍스트 대체물 (출하됨, `app/public/session-report.js`)**: 작업 단계 흐름도와 세션 실행 구조도는 `<figure aria-labelledby>` + `<svg role="img" aria-describedby>`로 두고, 그림 옆에 `.diagram-alt`(`#flow-alt`/`#arch-alt`)를 항상 함께 내보냅니다. 단계 흐름은 보고된 **모든** 단계를 일지 순서의 `<ol>`로(그림은 12개에서 자름), 구조도는 실행 계층 연결 순서와 역할 분담을 `<ol>`/`<ul>`로 나열합니다. 화면에 보이는 그림과 내보낸 파일의 텍스트 대체물이 같은 출처(문서 모델)에서 나옵니다.
  - **rem 기반 조판과 좁은 폭 대응 (출하됨)**: 문서 CSS는 여백·글자 크기·간격을 rem으로 정의하고, 각 섹션을 `container-type: inline-size`로 두어 **34rem 이하**에서 (1) 폭에 맞춰 축소된 SVG는 숨기고 `.diagram-alt` 텍스트 대체물만 남기며 (2) `table.data`를 `thead` 없는 카드형 행으로 쌓고 각 셀에 `data-label`을 붙여 열 이름을 유지합니다. 넓은 화면과 인쇄에서는 그림과 표가 그대로 나옵니다.
  - **자기완결 내보내기 + A4 인쇄 유지 (출하됨)**: 내보낸 HTML은 외부 CDN·폰트·이미지 의존성이 없고 스타일과 스크립트가 파일 안에 들어 있습니다. `@page{size:A4;margin:14mm}`와 인쇄 규칙(섹션별 `break-before: page`, 표·그림·푸터의 `break-inside: avoid`, 인쇄 시 그림 복원)을 그대로 유지하므로 같은 파일을 그대로 인쇄·PDF 저장할 수 있습니다. **독립 리뷰어 시각 점검**: 대표 현재 PDF 산출물을 직접 눈으로 확인한 결과 A4 4페이지 모두 잘림(clipping)·겹침 없이 읽을 수 있으며, 좁은 폭 레이아웃에서도 가로 넘침이 없음을 확인했습니다(후속 수정분에서도 인쇄 레이아웃 변경 없음).
- **통계 탭 (Statistics Tab, 순수 인라인 SVG 3종 보존)**:
  - 서드파티 라이브러리 없이 테마 토큰과 반응하는 순수 인라인 SVG 렌더링:
    1. **작업 관계도 SVG DAG (`renderTaskGraph`)**: 메인 에이전트와 하위 워커 간 의존성 DAG, 상태별 원형 인디케이터, 레인 번호, 소요 시간 곡선 에지.
    2. **비용·토큰 막대 차트 SVG (`renderCostChart`)**: 작업별 토큰 소모량 및 비용 수평 막대 차트.
    3. **메모리 구성 차트 SVG (`renderMemoryChart`)**: 활성/대체됨/격리 비율 SVG 도넛 차트 및 6대 메모리 유형 분포 막대.
  - **차트 값의 텍스트 노출 (독립 수용 완료, `app/public/visualize.js`)**: 세 차트 모두 `role="group"` + `<title>`/`<desc>`(`aria-labelledby`/`aria-describedby`)로 이름과 의미를 먼저 읽히고, 각 행은 `role="listitem"`의 `aria-label` 한 문장으로 **보고된 값을 그대로** 전달합니다(예: `빌드 · 1,200 토큰 · 비용 미보고`, `검토자 · 메인 작업에 의존 · 완료 · 레인 1`). 그림 자체는 `aria-hidden`이므로 스크린리더는 라벨만이 아니라 값과 관계를 읽습니다. 관계도는 "무엇이 무엇에 의존하는가"를, 비용 차트는 작업별 토큰·비용을 문장으로 노출합니다. 비용·모델 식별자는 대체 텍스트에 **전체 문자열**로 실립니다(잘라 쓰지 않음).
  - **없는 값은 없는 채로 (미집계/미보고) — 독립 수용 완료**: 서버가 유형 이름만 알리고 건수를 보고하지 않은 메모리 유형은 `0건`이 아니라 **미집계**로, 사용량·비용·레인·모델이 보고되지 않은 항목은 **미보고**로 남깁니다. 작업 상태는 알 수 없거나 누락된 값이면 **미보고**, 실제 `waiting`/`idle`일 때만 **대기**로 읽힙니다. 메모리 현황 합계가 보고되지 않으면 그대로 **미보고**로 남고, 서버가 보고한 0은 0으로 보이며, 도넛은 **모든 구성 값이 보고된 경우에만** 그립니다. 테마 삭제 라벨·건수·배지의 실제 live 계산 대비(다크 8.76/8.76/8.99, 라이트 5.74/5.74/5.11; ≥4.5:1)와 위 4건 결함 수정 모두 실측 회귀 포함 독립 수용되었습니다.
- **실시간 웹 미리보기 및 디자인 모드 (Live Web Preview & Design Mode, `#pane-preview`)**:
  - 로컬 웹 결과물을 iframe으로 실시간 렌더링.
  - `preview-inspector.js`(`postMessage` 통신) 기반의 **요소 선택 디자인 모드(Element-picker Design Mode)** 탑재: 화면 요소를 직접 클릭하여 태그, 선택자, 텍스트, 인라인 스타일 정보를 즉시 대화 입력창으로 전달하고 자연어 수정을 요청.
- **헤더 명시적 클라우드 전송 동의 토글 (`#consent-toggle`)**: 헤더 상단에 클라우드 라우트 전송 동의 토글을 명시적으로 배치.
  - **동의 꺼짐 (Off, 기본값)**: **로컬 실행 강제(Local Execution Enforced)**. 외부 클라우드로의 데이터 전송을 원천 차단하고 루프백 로컬 모델만 실행(게이트웨이 레벨에서 403 `consent_required`로 즉시 거절).
  - **동의 켜짐 (On)**: **클라우드 라우트 허용(Cloud Route Allowed)**. 사용자의 명시적 동의 확인 하에 외부 클라우드 모델 호출을 허용.
- **하단 상태 바 (Bottom Status Bar, `#status-bar`)**:
  - **좌측 측정 영역 (`#foot-stats`)**: 세션 전체에서 **하나의 누적 토큰 수치**를 보여주고, 구분자 `·`, 그 옆에 최근 메시지에서 측정한 `tok/s`, 마지막으로 `캐시 히트 %`를 둡니다. 같은 값을 다른 카드나 배지에서 되풀이하지 않습니다.
  - **우측 제어 영역**: `오케스트레이터` 모드 라벨(`#foot-mode`), 구분선 `|`, **하나의 모델 라벨**인 모델 버튼(`#foot-model`, 제품명 `VAYEX` + `Auto` 태그)과 **그 옆의 결정 출처 표기**(원격 결정 모델 / 로컬 대체 경로 / 원격 결정 건너뜀 중 실제 표시값), 회전 상태 `링 스피너`(`#foot-spinner`).
  - **상단 상태 표시는 한 곳에만**: 연결 상태·단계·실행 상태·플랜 모드를 헤더의 단일 상태 행에서만 표시합니다.
- **개인정보 보호 한 줄 (Privacy Line, `app.js` `privacy-line`)**:
  - 매 전송마다 `개인정보 보호 · 유형 · 조치 · 전송 여부` 한 줄을 대화 흐름에 표시하며, 조치 값에 따라 테두리 색이 갈립니다(`masked` / `blocked` / `review`).
  - 이 줄에는 **원문 값이 실리지 않습니다**. 유형과 조치, 그리고 요청이 실제로 나갔는지(`요청 전송됨` / `요청 보내지 않음`)만 노출합니다.
  - **이 줄이 그려지는 경로(수정 완료)**: 이전에는 게이트의 가명 기록이 브리지를 거치지 않아 화면에 아무 줄도 나타나지 않았습니다. 지금은 나가는 요청 하나에 프레임 하나를 릴레이하고, 요청별 상관 토큰으로 그 요청의 기록만 골라 씁니다(`app/server.mjs` `relayPrivacy`). 그래서 같은 세션의 다른 요청이나 대역외 `/api/privacy/scan`이 남긴 기록을 이 턴의 줄로 주장하지 않습니다.
- **도구 승인 버튼 라벨**: 코어가 보내는 select의 options를 그대로 버튼으로 만들되, 코어 라벨마다 한국어 라벨을 하나씩 둡니다(`app/public/protocol.js` `approvalLabel`). `Approve`/`Approve Once` → `한 번 승인`, `Approve File` → `파일에 대해 승인`, `Approve <대상> for this session` → `이 세션에서 <대상> 승인`, `Deny` → `거절`이며, 클릭 시 되돌려 보내는 값은 여전히 코어의 원문 라벨입니다.
- **좁은 폭 세션 헤더**: 헤더 메타 줄의 각 조각(토큰·역할·사유·모델 등)은 원자적 요소로 나뉘어 있고, 좁은 폭에서는 조각 사이에서 줄바꿈합니다. 이전에는 `140px` 상한이 줄 전체를 잘라 `사유: a…`로 끝났습니다(`app/public/styles.css`).
- **턴 비용 표기 (측정 토큰 × 공시 단가)**: 턴 비용은 보고된 사용량의 **측정 토큰 × 해당 모델의 공시 단가**로 계산합니다. `gateway/lib/cost-rates.mjs`의 모델별 단가표를 `gateway/lib/accounting.mjs` `costOf`가 입력·출력·캐시 읽기/쓰기 토큰에 적용해 USD를 산출합니다. 화면은 그 값을 `$0.000` 형식으로 표기하고(`app/public/protocol.js` `costLabel`), 사용량이 보고되지 않은 턴은 `0`으로 채우지 않고 미집계로 남기며, 계산된 0(로컬 실행의 과금 없음)과 값이 없는 상태를 구분합니다.
- **파일 변경 검토**: 작업 일지에는 완료된 한 줄 요약만 남기고, 파일별 변경 내역은 `변경 검토` 탭의 스냅샷 diff에서 확인하고 전체 또는 파일 단위로 되돌립니다.

### 6. 전송 전 프라이버시 가드 (`app/privacy/**`)

모든 외부 전송이 하나의 검사 지점을 지나도록 묶은 계층입니다. 검사 지점은 대화 본문, 도구 실행 결과, 첨부, 이미지·영상 프롬프트, 메모리 주입, 메모리 저장, 문서 내보내기, 진단 로그까지 포함합니다.

- **하나의 규칙 카탈로그**: 정규식 탐지에 체크섬 검증, 엔트로피 판정, 토큰 효율 판정을 더해 판단합니다. 민감하다고 판정된 값은 유형별로 가명 처리합니다.
- **구문에 맞춘 두 가지 가명 형태**: 본문에는 `[PERSON_1]` 형태를, 코드 식별자가 들어가는 자리에는 `__PII_PERSON_1__` 형태를 씁니다. 후자는 식별자로 유효한 문자만 남기므로 **가명 처리된 코드도 그대로 컴파일됩니다**.
- **확인된 자격증명은 전송 전에 차단**: 확인된 자격증명이 남아 있으면 업스트림 호출 전에 HTTP `422`로 거절합니다. 가명 처리된 본문은 와이어로 나가기 전에 다시 검증하며, 모든 클라우드 라우트에서 같은 규칙이 적용됩니다.
- **동의와 가명 처리는 별개로 기록**: 사용자 동의 여부와 가명 처리 여부를 하나의 값으로 합치지 않습니다. 동의는 화면의 토글로만 부여되고, 그 전에는 클라우드 라우트가 만들어지지 않습니다.
- **원문은 어디에도 남기지 않음**: 원문 값이 로그, 이벤트, 문서, 화면 어디에도 나타나지 않습니다. 화면에는 유형·조치·전송 여부만 한 줄로 남습니다.
- **측정된 동작**: 변형을 중복 제거한 코퍼스 48건에서 재현율 100%(48/48), 놓친 항목 0건. 저장소 코퍼스(앱·게이트웨이 원본)는 **약 37,000줄 규모·158개 파일**이며 이 코퍼스에서 오탐 0건, 정밀도 100%였습니다. 프라이버시 게이트 스캔 지연: p50 0.02~0.03 ms / p95 0.33~0.58 ms (배치 7 × 60건, 워밍업 2패스 폐기, 판정값 = 배치별 p95의 중앙값, 예산 p95 ≤ 5 ms). 20 KB 이상 대형 도구 결과는 이 예산의 측정 범위 밖이며 아직 미측정입니다. 코딩 안전성 검사에서는 운영 소스 파일 96개가 모두 게이트를 통과했고 차단 0건이었습니다.
- **선택 단계와 필수 단계의 구분**: 도우미 SLM 단계는 선택이며 상한이 정해져 있습니다. SLM이 없을 때도 정규식·체크섬 계층은 반드시 실행되고, 위험도가 높은데 검증할 수 없는 전송은 차단됩니다.
- **탐지 규칙 보강 라운드 (증상 → 원인 → 수정, 각 1줄)**:
  1. **화면에 개인정보 줄이 뜨지 않음** → 브리지가 게이트의 가명 기록을 프레임으로 릴레이하지 않음 → 나가는 요청 하나당 프레임 하나를 요청별 상관 토큰으로 묶어 보내고, 프레임·기록·로그·DOM 어디에도 원문 값이 없습니다.
  2. **한국어 문맥 키가 더 이상 가명 처리되지 않음** → 필드 경로를 정리하면서 탐지기가 쓰던 문맥이 사라짐 → 탐지 단계에는 원본 키를 힌트로 넘기고, 외부로 나가는 게시 단계만 정리된 경로를 씁니다.
  3. **`.env` 규칙이 꺼짐** → 호출자가 정한 키 텍스트에 `.example`/`.sample`/`.template`/`.dist`가 들어가면 규칙 자체가 비활성화됨 → 키 텍스트 예외를 제거했습니다.
  4. **실제 비밀값이 통과** → 진짜 비밀값에 플레이스홀더 줄을 덧붙이면 본문이 증거 임계치 아래로 내려감 → 비밀 형태의 값을 요구하고 플레이스홀더는 따로 셉니다.
  5. **가명 본문과 로그에 조각이 남음** → CRLF 줄 오프셋이 본문 구간을 밀어냄 → 실제 줄 텍스트로 구간을 계산합니다.
  6. **플레이스홀더 단어로 시작하는 값이 전부 면제됨** → `your`·`changeme`·`<` 같은 단어의 접두사 일치만으로 예외 처리됨 → 단어 전체가 한 세그먼트일 때만 예외입니다.
  7. **여러 형태가 빠져나감** → 엔트로피 하한 아래의 짧은 중립 키 비밀, 따옴표로 감싼 암호구, 패딩된 base64, 값 안의 `#`, 알파벳만으로 된 `user:pass` 쌍 → 각각을 별도로 막았습니다.
  8. **줄 머리 `KEY=` 밖의 자격증명이 빠져나감** → 탐지기가 줄 머리 대입만 읽음 → JSON(큰따옴표·작은따옴표), YAML, 줄 중간 `key: value`, URL 쿼리, CLI `--key value` 형태를 읽고 호출자의 키를 자격증명 힌트로 쓰되 값은 여전히 비밀 형태여야 합니다. 단독 `key`/`sortKey`/`next_key`는 자격증명이 아니므로 `app/config.json`을 붙여 넣어도 거절되지 않습니다.
  9. **남은 한계는 남아 있음** → `app/privacy/detectors.mjs`의 `DOCUMENTED RESIDUALS` 주석이 이 빌드에서 실제로 통과되는 값을 열거하고, `app/test/pii-mask.test.mjs`가 그 목록을 그대로 단언합니다. 즉 이 목록은 "고쳐졌다"가 아니라 **여전히 탐지되지 않는 형태의 공개된 목록**입니다.

### 7. 부스 시연 키트 및 운영 매뉴얼 (`booth/**`)

공학작품경진대회 현장에서의 안정적인 부스 운영을 위해 **(A) 상시 재생 영상**과 **(B) 현장 실작업 세션** 두 갈래 운영 체계를 구축하였습니다.

- **독립형 예제 프로젝트 (`booth/sample-project`)**: 외부 의존성 설치가 필요 없는 순수 HTML/CSS/JS 웹 애플리케이션입니다.
- **초고속 원클릭 원상복구 (`booth/reset.ps1`, `booth/reset.cmd`)**:
  - `booth/sample-project-pristine/` 원본을 바탕으로 대상 디렉터리를 100% 바이트 단위로 동기화 복원(Robocopy `/MIR` 활용).
  - 방문자 임시 파일 자동 제거, 변경 파일 강제 복구.
  - **실측 복구 시간: 약 1.1초 멱등 리셋**(`verify-reset.ps1` 1회차 1.096초, 변경 없는 재실행 1.022초. 5개 파일 전부 SHA256 바이트 일치).
- **현장 실작업 세션 (2~3분, 2:30 하드스톱)**:
  - 3분 세션 타임테이블(0:00 안내 → 0:20 요청 입력 → 0:40 도구 승인/거절 체험 → 1:30 미리보기 → 2:00 자동 검증 → 2:30 리셋).
  - 2:30 하드스톱 원칙: 지연 발생 시 즉시 중단하고 오프라인 스텁 거절 왕복으로 전환.
  - 현장 배포용 카드 3종(문구 변경, 버튼 색상 변경, 유효성 검증 추가).
- **5대 현장 비상 대응 경로 (5-Case Operator Fallback Table)**:
  1. 외부 API 오류 / 네트워크 단절 / 2:30 초과 → 오프라인 스텁 모드 전환 및 거절(Deny) 왕복 시연
  2. 예제 밖 파일 접근 시도 → 도구 승인 카드에서 즉시 [거절] 시연
  3. 코드 변경 결과 오류 → 스냅샷 되돌리기 또는 약 1.1초 `reset.ps1` 원클릭 복구
  4. 웹 UI 응답 없음 → 브라우저 새로고침 및 호스트 재기동, 상시 영상 2번 장면 관람 안내
  5. 노트북 하드웨어 장애 → 백업 USB 모니터 직결 단독 영상 재생 + 인쇄 패널 중심 설명
- **절감률 미측정 고지**: 오프라인 스텁 환경에서 확인된 시간 차이는 로컬 소켓 웜업 편차이며, 실제 유료 공급자 연동 시의 토큰 절감률과 비용 절감 규모는 **구조적 증명 상태이며 실측치는 미측정**입니다.

---

## 런타임 기동 및 실행 방법

### 1. 기본 `omp` 로컬 하네스 기동

```powershell
# 기본 기동 (브라우저 자동 오픈)
launch.cmd

# 또는 PowerShell 직접 실행
powershell -ExecutionPolicy Bypass -File launch.ps1

# 기동 확인만 수행 (Dry-Run)
powershell -ExecutionPolicy Bypass -File launch.ps1 -DryRun
```

기동 성공 시 브라우저가 작업 공간을 자동으로 열며, 기동 로그에 표시된 로컬 주소를 그대로 사용하면 단일 워크벤치 환경이 열립니다. 새 부스 세션은 실제로 응답하는 라우트에서 시작하므로 첫 요청이 실패하지 않습니다.

### 2. 부스 예제 복구 실행

```powershell
# 시연 후 예제 프로젝트 원상복구 (Git 불필요)
powershell -ExecutionPolicy Bypass -File booth\reset.ps1
```

---

## 설정 및 보안 경계

- **통합 설정 파일 (`app/config.json`)**:
  - `identity`: 사용자 식별자 (기본 `local-user`)
  - `inference.route.default`: 기본 라우트 모드 (`zdr_cloud`)
  - `inference.quota`: 일일 요청(200회) 및 토큰(200,000토큰) 예산 원장 경로
  - `inference.upstreams`: 업스트림 공급자 목록. 기본값은 기기 안에서만 응답하는 테스트용 `demo-stub`이며, 실제 추론을 위해서는 OpenRouter, A6API 등의 엔드포인트 및 환경변수 키(`OPENROUTER_API_KEY`, `A6API_KEY`)를 설정합니다.
- **보안 및 데이터 전송 경계**:
  - `local_only`: 로컬 제어 하에 있는 실행 경로로만 요청을 전달하며 외부 클라우드로의 데이터 전송을 원천 차단합니다.
  - `zdr_cloud` / `any_cloud`: 외부 전송에 대한 사용자 명시적 동의(Consent)를 필수로 요구합니다. 동의 없는 세션의 클라우드 요청은 게이트웨이 레벨에서 `403 consent_required`로 즉시 거절됩니다.
  - 비밀값 필터: 로그 및 스토리지 레벨에서 API 키, Bearer 토큰, 프롬프트 본문 노출이 원천 차단됩니다.

---

## 기적용된 결함 수정 및 개선 사항 (Fixes Applied)

1. **기본 설정 내 OMP 확장 모듈 등록 완료 (`app/config.json`)**:
   - `coreArgs` 기본 배열에 `["--extension", "omp/bounded-tool-result.js", "--extension", "app/memory/extension.mjs"]`를 정식 등록하였습니다.
   - 별도의 수동 CLI 플래그 없이도 네이티브 OMP 런타임 기동 시 장기 메모리 자동 수집/주입 및 20KB 초과 도구 출력 컴팩션·스필 복구 기능이 기본 활성화됩니다.
2. **메모리 SQLite DB 저장 경로 일원화 (Unified Memory DB Path)**:
   - `app/server.mjs`에서 `memoryRoot`와 `memoryDataDir`(`data/memory/`)를 단일하게 정의하고, 하위 프로세스 기동 환경변수로 `OMP_MEMORY_ROOT` 및 `OMP_MEMORY_DATA_DIR`를 자동 전달하도록 통일하였습니다.
   - HTTP 메모리 라우터(`/api/memory/*`)와 에이전트 확장(`app/memory/extension.mjs`)이 동일한 SQLite 파일(`data/memory/memory.db`)을 바라보게 되어 세션 간 지식 축적과 웹 UI 상태 조회가 동기화됩니다.
3. **벤치마크 CLI `--profile both` 옵션 버그 해결**:
   - `gateway/bench/run-benchmark.mjs`에 `profilesFor()` 헬퍼를 도입하여 `--profile both` 지정 시 단일 프로필 파라미터 전달 실패 버그를 해결하고, baseline 실행 후 optimized를 순차 실행하여 비교 분석 보고서를 생성하는 오케스트레이션 모드가 정상 동작합니다.

---

## 테스트 및 검증 메트릭

본 저장소의 기능은 모듈별 자동화 테스트 suite를 통해 검증됩니다. 아래 수치는 이 머신(Node.js v26.13.0)에서 실행한 결과입니다. **앱 계층 전체 행만 전체 lane 수치**입니다. 앱 전체·게이트웨이·장기 메모리·DX·인사이트 5개 행은 **2026-11-17 이 세션에서 직접 다시 실행한 실측값**이고, 나머지 행은 초점 실행 또는 이전 실행의 통과값(재사용)입니다.

| 테스트 스위트 | 실행 명령 | 총 테스트 수 | 성공 (Pass) | 실패 (Fail) |
| --- | --- | :---: | :---: | :---: |
| **앱 계층 전체(`npm test`)** | app에서 `node --test test/*.test.mjs` *(2026-11-17 실측, 약 103–146초)* | **264–265** | **264–265** | 0 (취소 0 · 생략 0) |
| **백엔드 초점 suite(수정 이전 실행 기록 — 현재 상태 아님)** | `node --test test/bridge.integration.test.mjs test/tool-compaction.test.mjs test/real-core.integration.test.mjs test/integrated.integration.test.mjs` *(app에서 실행, 과거 초점 통과치)* | **42** | **42** | 0 (취소 0 · 생략 0) |
| **보고서·차트 접근성(초점 suite)** | `node --test app/test/visualize.test.mjs app/test/memory-chart-truth.test.mjs app/test/report-accessibility.test.mjs` *(독립 수용)* | **17** | **17** | 0 (취소 0 · 생략 0) |
| **보고서 접근성 단일 파일** | `node --test app/test/report-accessibility.test.mjs` *(위 17/17과 중복 범위, 합산 금지)* | **10** | **10** | 0 (취소 0 · 생략 0) |
| **프론트엔드 Node 시험(셸 작성자 실행)** | 프론트엔드 Node 시험 24개(`frontend-native-keyboard.test.mjs` **7/7** + 기타 프론트엔드 17개, *전환 수정 리뷰에서 구현·시험 타당성 수용, 저장된 통과치 재사용*) | **24** | **24** | 0 (취소 0 · 생략 0) |
| **게이트웨이 코어** | `node --test gateway/test/*.test.mjs` *(2026-11-17 실측, 약 12초)* | **152** | **152** | 0 |
| **장기 메모리 계층** | `node --test app/memory/test/` *(2026-11-17 실측, 약 5.7초)* | **42** | **42** | 0 |
| **DX 계층** | `node --test app/dx/test/` *(2026-11-17 실측, 약 3.1초)* | **23** | **23** | 0 |
| **로컬 인사이트 계층** | `node --test app/insight/test/` *(2026-11-17 실측, 약 0.6초)* | **43** | **43** | 0 |
| **브라우저 회귀** | 브라우저 러너 (`app/public/frontend-regression.test.html`, *작성자 실행 · 드로어 독립 리뷰에서 통과치 재사용*) | **63** | **63** | 0 |
| **브라우저 서버 정합** | 브라우저 러너 (`app/public/frontend-server-truth.test.html`, *작성자 실행 · 드로어 독립 리뷰에서 통과치 재사용*) | **5** | **5** | 0 |
| **브리지 통합** | `node --test test/bridge.integration.test.mjs` *(초점 실행, 2회 모두 통과)* | **29** | **29** | 0 |
| **게이트웨이 suite(초점)** | 게이트웨이 초점 suite *(초점 실행)* | **36** | **36** | 0 |
| **게이트웨이 회계(할당량·비디오)** | 게이트웨이 회계 초점 시험 *(초점 실행)* | **12** | **12** | 0 |
| **프라이버시 findings(초점)** | 프라이버시 findings 초점 시험 *(초점 실행)* | **16** | **16** | 0 |

**전체 lane은 2026-11-17 실측 265/265 통과**(0 실패·0 취소·0 생략, 약 103초)입니다. 이 수는 보안 감사에서 추가된 회귀 시험(서버·게이트웨이·DX 라우트·프라이버시)을 포함하며, 감사 이전 기준선은 253이었습니다. 다만 이 lane을 부하에 면역이라고 주장하지 않습니다: (a) 같은 날 더 이른 실행은 부하 영향을 받아 **250 통과·1 실패·1 취소**였고(`test/integrated.integration.test.mjs:140`의 `test timed out after 15000ms`, `test/report-accessibility.test.mjs:262`의 Edge 헤드리스 스폰 `ETIMEDOUT`), 두 시험은 원인별로 수정되어 지금은 통과합니다. (b) `bridge.integration`의 `held startup disconnect …` 시험은 원래 페이지 측 `close` 이벤트를 기다렸는데, 루프백에서 그 커널 신호가 부하 시 유실되어(순수 http+undici 조합에서 450회 중 13회) 제품 결함 없이도 타임아웃이 났습니다. 지금은 제품이 소유한 지점(`peer.once('close')`, `peer.closed`, `peer.socket.destroyed`)에서 단언하며, 이 변경 뒤 파일 단독 2회·부하 병행 3회 모두 31/31 통과입니다(288–332ms, 예산 30s). 서버가 클라이언트 측 신호 유실을 보장할 수는 없으므로 "페이지가 절대 멈추지 않는다"고는 주장하지 않습니다. 이 lane에는 프라이버시 suite, `bridge.integration`, `privacy-benchmark`, Edge로 구동하는 프론트엔드 시험이 포함됩니다. 부하에 민감하던 실패 3건(그중 1건은 실제 제품 결함)의 진단·수정은 `app/README.md`의 '실제 수행한 검증'에 있습니다. 이전 인증 실행에서 핑거프린트한 앱·게이트웨이 산출물 **176개는 전부 불변**, 추가 0건, 실행 전후 Node/Bun/Chrome 프로세스 수는 **0 대 0**이었습니다. 이전 실행의 **160개 중 153 통과·6 실패·1 취소**는 **과거 기록**이며 현재 상태가 아닙니다. 보고서·차트 초점 suite **17/17** 및 `report-accessibility.test.mjs` **10/10**(중복 범위, 합산 금지)은 실제 계산 대비 회귀 포함 **독립 수용**되었고, 프론트엔드 Node **24/24**(`frontend-native-keyboard` **7/7** + 기타 **17/17**), 브라우저 회귀 **63/63**, 서버 정합 **5/5**, 게이트웨이 회계 **12/12**, 게이트웨이 suite **36/36**, 프라이버시 findings **16/16**, 브리지 통합 **29/29**(2회)도 초점 통과치로 유지됩니다. 게이트웨이 **152/152**, 장기 기억 **42/42**, DX **23/23**, 인사이트 **43/43**은 2026-11-17 이 세션에서 직접 다시 실행한 실측값이고, 엔진 기준선 **319**만 이전 실행에서 통과한 값을 그대로 적은 것(재사용)이며, 부분 suite를 합산해 전체 통과로 취급하지 않습니다. 이전 실행의 **156/156** 통과는 과거 기록으로만 남기며 현재 상태를 대신하지 않습니다. 보고서·차트 초점 suite **17/17** 및 갱신된 `report-accessibility.test.mjs` **10/10**(서로 중복 범위이므로 합산 금지, 실패·취소·생략 0)은 실제 계산 대비 회귀 포함 **독립 수용(accepted)**을 마쳤습니다. 반응형 셸은 드로어 결함 3건과 스코프된 전환 결함(`Element.animate` 180ms 장식 전환으로 대체) 수정이 **독립 수용**되었습니다(프론트엔드 Node **24/24**, 브라우저 **63/63**, 서버 정합 **5/5**, 저장된 통과치 재사용). `legacy-scan app/public`은 가이드 코퍼스의 약 **20%**만 결정적 규칙으로 덮으므로 0건이 전체 접근성 보증이 아닙니다. 게이트웨이 **152/152**, 장기 기억 **42/42**, DX **23/23**, 인사이트 **43/43**은 2026-11-17 이 세션에서 직접 다시 실행한 실측값이고, 엔진 기준선 **319**만 이전 실행에서 통과한 값을 그대로 적은 것(재사용)이며, 부분 suite를 합산해 전체 통과로 취급하지 않습니다.

고친 결함은 다음과 같습니다(증상 → 원인 → 수정). 독립 리뷰가 보고서·차트 접근성, 드로어 수정, 전환 수정, 준비 수명주기, 시험 계약(경로 독립성·카나리·스코프된 수명주기 시계), 할당량·비디오 수정, **peer teardown**을 **수용**했습니다.

- **OMP 준비 판정(증상: 준비 대기가 `protocol_mismatch`로 라벨링)** → 원인: startup 탐색 구간을 협상 타이머가 판정 → 수정: 준비 단계에 별도 **60초 상한 `startup_timeout`**을 두고, ready 이전 중단은 `startup_cancelled`로 끝내며, `ready` 이후에만 별도 **15초 `negotiation_timeout`**이 시작됩니다. 모든 종료 경로가 자식을 종료하고 종료를 기다린 뒤 admission을 반납하고 peer를 닫습니다.
- **출력 계약(증상: 바이트 단언 2건 실패)** → 원인: 1초 이상 실행에서 OMP가 붙이는 네이티브 `Wall time` 접미사를 stdout 단언이 전제하지 않음 → 수정: 실제 출력을 **손실 없이** 보존하도록 기대를 정정하고 경계·복구 회귀를 결정적으로 추가했습니다.
- **세션 정리(증상: peer teardown 미완료) — 독립 수용 완료** → 원인: `Peer.close()`가 닫힘 핸드셰이크에 응답하지 않는 peer에서 전송을 **CLOSING에 영구 고착**시켜 `close`가 발생하지 않음 → 수정: 정리 시 peer 전송을 **능동 파괴**하고, 종료 shutdown 중 admission을 **동기적으로 반납**해 exit 대기자가 여전히 admitted 상태로 보지 않도록 했으며(소켓 close 전달을 보류하는 child-exit-boundary 회귀로 입증), `stopChild`를 SIGKILL 에스컬레이션을 유지한 **단일 실행(single-flight)**으로 만들고, peer 폴백 destroy 타이머를 추적해 소켓 close 시 취소함으로써 이중 destroy가 없도록 했습니다. 재리뷰에서 새로운 경합은 발견되지 않았습니다.
- **할당량 원장(증상: job 수락 후 500)** → 원인: 비디오 경로의 업스트림 후 `settle`이 다른 핸들이 `quota-ledger.json`을 쥔 상태의 Windows 원자적 교체에서 `EPERM`을 만나, `GatewayError`가 아닌 오류로 새어 500이 됨 → 수정: 일시적 교체 오류에 **약 140ms 한도 재시도**, 예산을 넘으면 오류를 그대로 올리고, 예상 밖 500은 리댁션된 원인을 기록하며, 원장 읽기 경로도 같은 주입 파일시스템 seam을 씁니다. `quota.ledger_path`는 로컬·비동기화 경로여야 합니다(`gateway/README.md`에 문서화).
- **CWD 가정(증상: CWD에 따라 깨지는 경로)** → 원인: 시험 3개가 프로세스 CWD로 `app/app/...` 경로를 구성 → 수정: 모듈 상대 경로로 바꾸고 app CWD와 프로젝트 루트 양쪽에서 확인했습니다.
- **비밀 카나리(증상: 43건 매치)** → 원인: 모두 자격 증명이 아닌 값(생성된 transcript/blob 해시, Edge 환경설정 무결성 MAC, 의도된 픽스처) → 수정: 스캔 범위를 값별 허용과 함께 정정하고, 픽스처 내부를 포함한 현실적 자격 증명 형태에 대한 양성 통제를 추가했습니다.
- **키보드 시험 7건이 조용히 생략됨(증상: `Google Chrome not found`)** → 원인: 브라우저 탐색이 Chrome 설치 경로만 확인해, Edge가 있는 머신에서도 실제 커버리지가 빠짐 → 수정: `CHROME_PATH`와 함께 Chrome·Edge·Chromium의 표준 설치 경로를 찾고, **정말 하나도 없을 때만** 생략하며 사유에 빠진 능력을 지목합니다(`app/test/frontend-native-keyboard.test.mjs`).
- **수명주기 시험이 부하에서 간헐 취소(증상: 실행마다 다른 1~2건 실패/취소)** → 원인: 실시간 대기가 이름 없는 개별 타임아웃을 쓰고 러너 타임아웃과 경합 → 수정: 모든 대기가 하나의 명시적 예산(`LIFECYCLE_BUDGET_MS`)을 공유하고 러너 타임아웃은 그 위에 두어, 멈춤이 나면 멈춘 단계의 이름을 대고 실패합니다(`app/test/bridge.integration.test.mjs`).

웹 UI는 Google Chrome [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance-src)의 가이드(`ime-safe-enter-submit`, `accessibility`, `tabs`, `dialog`, `menu`, `container-queries`, `print` 등)를 적용했습니다. 한글 조합을 확정하는 Enter가 diff 조회·미리보기 이동을 일으키지 않고, 실패한 diff 조회는 이전 작업의 카드를 지운 뒤 알림 영역으로 이유를 전합니다. 인스펙터 탭은 선택된 탭 하나만 Tab 정지점이 되고, 문서 유형은 네이티브 라디오 그룹, Theme Studio는 네이티브 모달 `<dialog>`입니다. 미리보기 디자인 모드에서는 포커스된 요소를 `Alt+Enter`로 검사하며 일반 Enter·Space는 원래 동작을 유지합니다. `legacy-scan app/public`은 가이드 코퍼스의 약 20%만 결정적 규칙으로 덮으므로 지적 0건이 전체 접근성 보증이 아닙니다. 반응형 셸은 넓은 데스크톱 비율(`>=1180px` 260/364), 좁은 화면 무가로넘침(`320px`/`640 CSS px`), 드로어 결함 3건 수정이 **독립 수용**되었으나, 실제 브라우저 `200%` 줌은 미검증(두 번의 시도가 모두 도구 사유로 실패, `320px`/`640 CSS px` 등가가 유일한 레이아웃 근거)이고, 스코프된 전환의 인스펙터 히트 테스트 상실 결함은 `Element.animate` 180ms 장식 전환으로 대체되어 **독립 수용**되었습니다(상태·ARIA·포커스 동기화 즉시 반영, reduced-motion·API 부재 폴백 유지, 실제 앱 애니메이션 20초 연장 상태에서 실제 터치·마우스 입력 통과, 프론트엔드 Node **24/24**·브라우저 **63/63**·서버 **5/5** 재사용). 실제 `200%` 줌은 여전히 미검증이므로 전체 UI를 완전 검증으로 주장하지 않습니다. 보고서·차트 접근성(차트 값·관계의 텍스트 노출, 미집계/미보고 보존, 다이어그램 텍스트 대체물, 34rem 이하 표 쌓기, A4 인쇄, 삭제 대비)은 독립 수용되었습니다. 이전에 빨간색이던 통합 시험 3건은 증상이 아니라 원인에서 수정했습니다. ① 호스트의 전역 OMP 상태 디렉터리가 CLI 오버레이 시험으로 새던 문제(지금은 시험마다 격리된 상태 디렉터리를 씁니다), ② `compactToolOutput`이 500줄짜리 반복 페이로드를 91바이트로 축약해 버리던 문제(지금은 시험·빌드 로그 패턴으로만 축약을 적용합니다), ③ 병렬 Bun 스폰 사이에서 `HOME`이 격리되지 않던 문제입니다.

---

### 실측 2환경 비교 (Live 2-Environment Benchmark, 공식 단가 기준)

과제 4종(단일 라인 수정, 프론트엔드 컴포넌트, 다중 파일 리팩터링, 복합 디버깅)을 환경별로 3회씩 반복 실측하여 총 24슬롯을 측정했습니다. 비용은 측정 토큰 × 공시 단가로 산출한 추정치(과제당 3회 합산), 소요 시간은 과제 1회 수행 기준 중앙값입니다. Claude는 게이트웨이 단일 모델 호출입니다. 원자료와 검증 로그는 `output/benchmark-live-2env-official-report.md`, `output/benchmark-live-2env-official-result.json`에 있습니다.

#### 1. 비교 대상 두 환경
1. **Claude Opus 5.5 (`anthropic/claude-opus-5-5`)**: 측정 호스트에 Claude CLI가 없어 게이트웨이 경유 단일 모델 호출(`single_model_gateway_call`)로 측정했습니다.
2. **VAYEX 하네스 (역할 라우팅)**: 역할 라우팅을 거쳐 원격 게이트웨이가 실제 작업 모델을 선택하는 복합 에이전트 경로입니다.

이번 실행은 위 두 경로만 측정했으며, Codex CLI와 DeepSeek V4.1 Flash 단일 모델 호출은 애초에 대상에 넣지 않았습니다. 제외 이전의 4환경 측정에서는 Codex CLI가 원격 제공자 용량 초과(HTTP 503)로 빠졌고, 그 기록은 `output/benchmark-live-4env-report.md`, `output/benchmark-live-4env-taskfix-report.md`에 제외 이전 자료로만 남아 있습니다.

#### 2. 통과 수와 과제 1회 수행 소요 시간 (실측)

| 환경 | 실행 | 통과 | 성공률 | 3회 전부 통과 과제 | 과제 1회 수행 소요 시간(중앙값) | TTFT 중앙값 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Claude Opus 5.5 (게이트웨이 단일 모델 호출)** | 12 | 12 | 100.0% | 4/4 | 24,361 ms | 3,414 ms |
| **VAYEX 하네스 (역할 라우팅)** | 12 | 12 | 100.0% | 4/4 | 46,205 ms | 3,953.5 ms |

#### 3. 공식 단가 기준 비용

단가는 각 제공사의 공시가를 씁니다. Claude는 입력 $4.00 / 출력 $20.00 / 캐시 읽기 $0.20 / 캐시 쓰기 $5.00(1M tokens, `docs.claude.com`). VAYEX는 실행마다 실제로 라우팅된 모델의 단가로 계산합니다. DeepSeek 라우팅은 `deepseek-v4.1-flash-1017` off-peak(캐시 미적중 입력 $0.15 / 캐시 적중 $0.003 / 출력 $0.60, `api-docs.deepseek.com`), Gemini 라우팅은 Gemini 3.8 Flash 표준(입력 $0.75 / 출력 $3.75 / 캐시 읽기 $0.075, `ai.google.dev`)입니다. 이전의 사용자 제공 단가표와 drex-max-v1.1 $0.03/1M 항목은 사용하지 않습니다.

| 환경 | 측정 토큰 (input / output / cache read) | 총 비용 | 성공 과제당 비용(추정) |
| --- | :---: | :---: | :---: |
| **Claude Opus 5.5 (게이트웨이 단일 모델 호출)** | 9,240 / 59,469 / 8,064 | $1.1956968 | **$0.2989242** |
| **VAYEX 하네스 (역할 라우팅)** | 9,240 / 63,856 / 8,064 | $0.0662071 | **$0.0165518** |

산식은 (캐시 미적중 input × input 단가 + 캐시 적중 × 캐시 적중 단가 + output × output 단가) ÷ 1,000,000입니다. input은 캐시 읽기를 포함한 prompt 토큰이므로 미적중분에만 input 단가를 적용했습니다. 성공 과제당 비용(추정)은 총 비용 ÷ 4개 과제이며, 과제별 3회 수행분의 측정 토큰 × 공시 단가 합계를 과제 수로 나눈 값입니다. 캐시 쓰기 토큰은 전송 계층이 보고하지 않아 비용에 넣지 않았습니다.

VAYEX 비용 배분: 이번 실행은 DeepSeek 라우팅 10회($0.0332413)와 Gemini 라우팅 2회($0.0329658)로 나뉘었고, Claude로 라우팅된 실행은 없었습니다. 라우팅 대상은 실행별 응답 헤더 `x-opencodex-request-id`를 기록한 뒤 게이트웨이 관리 API `GET /api/request-history/{requestId}/route-decision`으로 회수했습니다. 게이트웨이는 호출별 USD를 보고하지 않으므로, 위 비용은 이렇게 회수한 라우팅 대상의 공시 단가 × 측정 토큰으로 계산한 값입니다.

---

## 한계 및 미결 사항 (Known Open Items)

미결 사항과 한계는 다음과 같습니다.

1. **비용·속도 벤치마크와 오프라인 스텁 결과의 한계 (`gateway/bench/run-benchmark.mjs`, `scripts/benchmark-comparison.mjs`)**:
   - `scripts/benchmark-comparison.mjs`의 모의 추정 결과에 명시된 토큰 절감률(**11.2%**) 및 비용 절감률(**38.1%**)은 프롬프트 길이 및 캐시 적중률 가정을 바탕으로 한 **합성 시뮬레이션(Synthetic Simulation)**이며, 실제 모델 호출을 통한 실측 결과가 아닙니다.
   - 실제 오프라인 루프백 스텁(`gateway/stub/stub-upstream.mjs`)을 대상으로 벤치마크를 수행한 결과, `baseline`과 `optimized` 프로필 모두 완전히 동일한 토큰 수치(입력 84, 출력 60)와 동일한 비용(0.000264 USD), `cacheRead: 0`을 기록합니다.
   - 측정된 실행 시간 차이(~309ms 대 ~245ms)는 모델 추론 속도 개선이 아닌 로컬 루프백 소켓의 웜업 편차(Warm-up noise)에 불과합니다.
   - 실제 외부 상용 LLM API 연동 시의 토큰 절감률과 비용 절감 규모는 **미측정(Unmeasured)** 상태입니다.
2. **원격 워커 과금 미관측**:
   - 게이트웨이는 호출별 USD를 보고하지 않으므로, 비용은 실행별로 회수한 라우팅 대상의 공시 단가 × 측정 토큰으로 계산한 값이며 실제 청구서와 일치한다고 주장하지 않습니다. 하네스 세션의 `usage.cost`는 0으로 채워질 수 있어 그 값을 과금 없음으로 해석하지 않고, 사용량이 보고되지 않은 턴은 미집계로 남깁니다.
   - 라우팅 대상 회수는 게이트웨이 관리 API(`GET /api/request-history/{id}/route-decision`)에 의존합니다. 이 API가 무인증으로 열려 있어 요청 크기·토큰·계정 지문이 노출되는 보안 문제가 있으며, 이 프로젝트가 고칠 수 있는 범위가 아닙니다.
3. **번들 가중치 부재 및 데모 스텁 기본값**:
   - 저장소에는 실제 대규모 LLM 가중치가 포함되어 있지 않으며, 기본 설정은 루프백 데모 스텁을 가리킵니다. 실무 환경에서는 외부 공급자 엔드포인트와 API 키 등록이 필수적입니다.
   - 백그라운드 SLM 레지스트리(`app/insight/local-model.mjs`)의 후보 `Qwen2.5-0.5B-Instruct`(q4f16, 461 MB ONNX)와 `Qwen3.5-0.8B`(q4f16, 520 MB ONNX) 가중치도 기본 번들 대상이 아니며, 이 머신에 설치되어 있지 않아 **미측정 후보**입니다. 설치 전까지 백그라운드 요약·제목·작업 일지·다이제스트는 **규칙 기반 폴백(rule-fallback)** 으로 동작합니다.
4. **초기 Python 계층과의 런타임 분리**:
   - `engine/`, `prototype/`, `harness/`에 존재하는 Python 코드는 Node/Bun 기반의 현재 `omp` 하네스 실행 경로와 내부적으로 연결되어 있지 않습니다.
5. **2환경 비교의 한정**:
   - Claude 행은 게이트웨이를 경유한 단일 모델 호출이며 Claude Code CLI 실행이 아닙니다. VAYEX 행은 역할 라우팅을 거친 복합 에이전트 경로입니다.
   - VAYEX 비용은 실행별 라우팅 대상에 따라 달라집니다. 이번 실행은 DeepSeek 10회·Gemini 2회였고, Claude로 간 실행은 0회였습니다. 역할 라우팅은 실행마다 다른 모델로 분배되므로 한 번의 측정으로 일반화하지 않으며, 표기하는 비용은 실행별 라우팅 대상의 공시 단가 × 측정 토큰으로 계산한 집계값입니다.
   - Codex CLI는 원격 제공자 용량 초과(HTTP 503)로, DeepSeek 단일 모델 호출은 비교 기준에서 제외했습니다. 제외 이전의 4환경 측정 기록은 `output/benchmark-live-4env-report.md`(최초 명세), `output/benchmark-live-4env-taskfix-report.md`(정정 명세)에 남아 있습니다.
6. **연결 끊김 처리의 남은 동작**: 입력 대기열 한도 초과 시의 동작과 감지되지 않는 peer 유형은 `app/README.md`의 '연결 끊김과 입력 대기열'에 있습니다.
7. **반응형 셸 및 UI (드로어 3건·전환 입력 결함 독립 수용 완료 · 실제 200% 줌 미검증)**: 반응형 셸은 `>=1180px` 260/364 비율, `320px`/`640 CSS px` 무가로넘침, 그리고 드로어 결함 3건(`Shift+Tab` 스킵 링크 이탈, 드로어 닫힘 후 `fullscreen` 인스펙터 잔류, 사이드바 검색·메모리 목적지 숨김/`inert`) 수정이 저장된 구현·회귀 검사 및 작성자 통과치 재사용으로 **독립 수용**되었습니다(`legacy-scan`은 가이드 코퍼스의 약 20%만 덮으므로 0건이 전체 접근성 보증이 아님). ① 스코프된 **ViewTransition** 전환이 전환 중 인스펙터 히트 테스트를 잃던 결함은 그 의미론을 폐기하고 **`Element.animate` 180ms 불투명도·6px 이동의 장식용 수신 패널 전환**으로 대체해 **독립 수용**되었습니다(상태·ARIA·포커스 동기화 즉시 반영, `prefers-reduced-motion`·API 부재 폴백 유지, 회귀 시험은 실제 앱 애니메이션을 **20초로 늘린 상태에서** 실제 터치 스터디·마우스 스펙이 **동작 중 통과**). 신규 리뷰어가 구현과 시험 타당성을 수용했고 통과치는 저장된 실행을 재사용했습니다(재실행 없음): 프론트엔드 Node **24/24**(`frontend-native-keyboard` **7/7** + 기타 **17/17**), 브라우저 **63/63**, 서버 **5/5**. 이로써 프론트엔드의 알려진 입력 결함은 해소되었습니다. ② 실제 브라우저 `200%` 줌은 **미검증**입니다. 격리된 Edge에서 두 번 시도했으나 모두 **도구 사유로 실패**했고(175%까지 도달 후 최종 줌 입력이 `user_input_active`로 끝남, 이후 격리 Edge가 조기 종료), `320px`/`640 CSS px` 등가가 **유일한 레이아웃 근거**이므로 `200%` 사용성은 주장하지 않습니다. 따라서 제품 전체 검증은 완료가 아니며(`200%` 줌 등 제한 사항은 위·아래 항목에 명시), 보고서·차트 접근성(**17/17**, `report-accessibility.test.mjs` **10/10**)과 드로어 3건의 독립 수용 상태는 그대로 유지됩니다.

