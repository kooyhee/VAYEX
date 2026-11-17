# Live 4-환경 실측 벤치마크 보고서 (실결제·실계정 라이브 측정)

> **결과셋 라벨:** 과제 명세 정정 후 재측정 (공정 비교)
> **측정 모드:** `live` (실측 — 오프라인 시뮬레이션 값 없음)
> **실행 명령:** `node scripts/benchmark-live-4env.mjs -n 3 --resume --prompt-mode=corrected --out=output/benchmark-live-4env-taskfix-result.json --md-out=output/benchmark-live-4env-taskfix-report.md`
> **실행 시작:** 2026-11-08T11:45:34.285Z | **총 실행 시간:** 5340.9s
> **슬롯:** 48/48 기록 완료 (4 환경 × 4 과제 × N=3)
> **생성 시각:** 2026-11-08T13:16:11.420Z

## 0. 측정 대상과 경로 (환경 정의)

| 환경 | 종류 | 모델 / 노력도 | 실행 경로 |
|---|---|---|---|
| Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `cli_agent` / `codex_exec` | `gpt-6.1-sol` / effort=`high` | 원격 codex-cli 0.150.1 + opencodex OpenResponses provider. model=gpt-6.1-sol, model_reasoning_effort=high |
| Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | `single_model_gateway_call` / `gateway_chat` | `anthropic/claude-opus-5-5` / effort=`medium` | POST https://[REDACTED_GATEWAY_HOST]/v1/chat/completions (model=anthropic/claude-opus-5-5, reasoning_effort=medium, TLS 443 암호화) |
| DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | `single_model_gateway_call` / `gateway_chat` | `thehive/deepseek-ai/deepseek-v4.1-flash-1017` / effort=`high` | POST https://[REDACTED_GATEWAY_HOST]/v1/chat/completions (model=thehive/deepseek-ai/deepseek-v4.1-flash-1017, reasoning_effort=high, TLS 443 암호화) |
| VAYEX 하네스 (역할 라우팅: combo/main) | `harness_role_routing` / `gateway_chat` | `combo/main` / effort=`게이트웨이 라우터 결정` | POST https://[REDACTED_GATEWAY_HOST]/v1/chat/completions (model=combo/main, effort 미지정, TLS 443 암호화 → 게이트웨이 jev 결정모델 drex-max-v1.1 가 모델·effort 선택) |

> - Claude 환경은 **Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치)** 이다. 원격 호스트에 `claude` CLI 가 설치되어 있지 않아 CLI 실행으로 표기하지 않는다.
> - VAYEX 하네스 환경: 로컬 하네스 HTTP 엔드포인트(`127.0.0.1:6463`)가 응답하지 않아 **같은 프로토콜(역할 요청 → `combo/main`)으로 원격 게이트웨이를 직접 호출**하여 측정했다. 결정 모델은 게이트웨이의 Nace `drex-max-v1.1` 이다.
> - Codex CLI 환경: 원격 ChatGPT 계정 직접 호출로는 `gpt-6.1-sol` 이 `model_not_found`(400)로 거부되어, 실제 라우트인 opencodex provider(`wire_api=responses`) 경유로 `codex exec --json` 을 실행했다.

---
## 1. 환경별 종합 실측 요약 (Overall Comparison)

> ### 📌 [비교 대상의 실제 범위 및 측정 조건]
> - **실제 유효 측정 대상 (3개 환경)**: `Claude Opus 5.5`, `DeepSeek V4.1 Flash 1017`, `VAYEX 하네스(combo/main)` 3개 환경에서 실제 코드가 실행되고 히든 테스트 검증이 완료되었습니다.
> - **측정 불가 차단 대상 (1개 환경)**: `Codex CLI`(`gpt-6.1-sol`)는 CLI 실행 시 `Selected model is at capacity. Please try a different model.` 에러를 반환하며 전 슬롯 시도가 차단되었습니다 (게이트웨이 직접 프로브 시 HTTP 503 `server_is_overloaded`, `local native-main profile maintenance is active` 확인). 이는 모델의 구현 실패가 아니므로 **"0% 성공률"로 왜곡하지 않고 "미측정(측정 불가)"**으로 명시합니다.
> - **Claude 측정 조건**: 원격 호스트에 `claude` CLI 가 설치되어 있지 않으므로, Claude 환경은 CLI 실행이 아닌 **"Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치)"**로 측정되었습니다.

| 환경 (Environment) | 상태 (Status) | 유효 시도 | 성공 횟수 | 성공률 (Success Rate) | 성공 실행 중앙 지연 (ms) | TTFT 중앙 (ms) | 성공 실행당 토큰 (Median / Mean) |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 🔴 미측정 (원격 용량초과/유지보수) | 12회 시도 | — | 미측정(측정 불가) | — | — | — |
| Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 🟢 실측 완료 | 12회 시도 | 12회 | 100.0% | 14,569 | 미수집 | 2,767.5 / 3,455.1 |
| DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 🟢 실측 완료 | 12회 시도 | 11회 | 91.7% | 58,386 | 미수집 | 9,604 / 10,664.9 |
| VAYEX 하네스 (역할 라우팅: combo/main) | 🟢 실측 완료 | 12회 시도 | 10회 | 83.3% | 67,265.5 | 1,881.5 | 7,768 / 7,159 |

> **표 해석 주석:**
> 1. "성공률" 열은 실제로 정상 실행을 완주한 환경에만 계산치를 부여하며, 원격 503 과부하로 차단된 `Codex CLI`는 **"미측정(측정 불가)"**으로 표기하여 오인을 차단합니다.
> 2. 성공 실행 중앙 지연(Wall-clock ms)은 **히든 테스트를 100% 통과한 성공 실행**의 실측 중앙값입니다.

---
## 1.1 실패 분류 체계 (Failure Taxonomy Breakdown)

모델의 가용성 문제(호출 불가)와 코드 작성 결함(구현 실패), 타임아웃을 명확히 구분하여 평가합니다.

| 환경 | 총 시도 | 가용성 실패 (호출 차단 / 503) | 구현 실패 (히든 테스트 불통과) | 타임아웃 (시간 초과) | 세부 실패 내역 및 불통과 테스트 |
|---|:---:|:---:|:---:|:---:|---|
| Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 12 | 12회 | 0회 | 0회 | 원격 `gpt-6.1-sol` 503 유지보수 및 `Selected model is at capacity` 로 전 슬롯 시도 불가 |
| Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 12 | 0회 | 0회 | 0회 | 실패 없음 (전량 통과) |
| DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 12 | 0회 | 1회 | 0회 | task-b-frontend-component (1회, hidden_test_failure): 5/5 hidden tests failed: Renders title and value correctly; Applies correct status badge classes (success, warning, error); Includes accessible button toggle with aria-expanded attribute; CSS defines responsive rules for max-width 768px; Dark mode theme class support |
| VAYEX 하네스 (역할 라우팅: combo/main) | 12 | 0회 | 2회 | 0회 | task-d-complex-debugging (2회, hidden_test_failure): 3/5 hidden tests failed: Cancelled tasks clean up timers immediately; Listener count does not increase per retry attempt; High concurrency 500 tasks stress test leaves 0 dangling listeners and timers |

---
## 1.2 과제 B(프론트엔드 컴포넌트) 명세 정밀 감사 (Task-B Specification Defect Audit)

> ### ⚠️ [과제 B 실패의 본질: 모델 결함이 아닌 "과제 명세 불완전(전 환경 공통)" 판정]
> 실측 결과 가용 환경 3종(Claude, DeepSeek, VAYEX) 모두 `task-b-frontend-component`에서 100% 불통과를 기록했습니다.
> `scripts/lib/benchmark-tasks.mjs`의 프롬프트와 `live-hidden-evaluator.mjs`의 검증 단언문을 대조 감사한 결과:
> 1. **배지 클래스명 미명시**: 프롬프트는 `status badge (success: green, warning: yellow, error: red)`라고만 지시했을 뿐, 히든 테스트가 요구하는 구체적 CSS 클래스명(`badge-success`, `badge-warning`, `badge-error`)을 전혀 명시하지 않았습니다. 모델들은 의미론적으로 유효한 다양한 클래스(예: `metric-badge success`, `status-green`, `badge--success`)를 구현했으나 문자열 일치 검사에서 탈락했습니다.
> 2. **다크 모드 클래스명 미명시**: 프롬프트는 `supports dark mode class`라고만 명시하여, 히든 테스트가 요구하는 `theme-dark` 또는 `dark-mode` 클래스명을 사전에 연역할 수 없었습니다.
> 따라서 본 원본 결과셋(as-shipped prompt)의 과제 B 실패는 **모델 역량 차이가 아닌 과제 설계 결함(Task-Design Defect)**이며, 공정한 비교를 위해 명세를 구체화한 보정 세트(`output/benchmark-live-4env-taskfix-*`)를 별도 산출물로 분리 대조합니다.

---
## 1.3 과제 B 명세 정정 전후 대조 (공정 비교)

명세 누락으로 전 환경이 실패한 최초 세트와, 요구 계약(badge-success/warning/error 클래스명 및 theme-dark/dark-mode 식별자)을 프롬프트에 명시한 정정 세트의 과제 B 결과를 나란히 둔다. 정정 세트가 공정 비교 기준이다.

| 환경 | 최초 명세 그대로 통과 | 정정 명세 통과 | 최초 판정 | 정정 판정 |
|---|---|---|---|---|
| Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미측정/3 | 미측정/3 | 측정 불가 | 측정 불가 |
| Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 0/3 | 3/3 | 과제 명세 불완전(전 환경 공통) | 명세 정정 후 통과 |
| DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 0/3 | 2/3 | 과제 명세 불완전(전 환경 공통) | 명세 정정 후 통과 |
| VAYEX 하네스 (역할 라우팅: combo/main) | 0/3 | 3/3 | 과제 명세 불완전(전 환경 공통) | 명세 정정 후 통과 |

---
## 2. 비용 뷰 (공시 단가 비용 / 구독 등가 가정 분리)

환경별 1M 토큰 단가표를 적용한 공시 단가 비용과, 구독 한계 유출 가정을 분리한다. 하단의 구독 등가 열은 가정 유도값이며 측정값과 합산하지 않는다.

| 환경 | (A) 측정 토큰량 (실측) | 적용 단가 (USD / 1M tokens) | (B) 공시 단가 비용 | 비용/성공 과제 | (C) 구독 등가 비용 (가정) |
|---|---|---|---:|---:|---|
| Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미보고(전송 계층이 usage 미출력) | in $0.2 / out $1 / cacheRead $0.01 / cacheWrite $0.25 | 미측정 | 미측정 | 구독 쿼터 한계 유출 $0.00 (가정, 측정값 미포함) |
| Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | prompt 12,891 / completion 28,570 / cached 11,897 → total 41,461 | in $0.08 / out $0.4 / cacheRead $0.004 / cacheWrite $0.16 | $0.011555 | $0.002889 | 구독 쿼터 한계 유출 $0.00 (가정, 측정값 미포함) |
| DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | prompt 4,916 / completion 112,398 / cached 512 → total 117,314 | in $0.0081 / out $0.0323 / cacheRead $0.00016 / cacheWrite $0 | $0.003666 | $0.001222 | 구독 쿼터 한계 유출 $0.00 (가정, 측정값 미포함) |
| VAYEX 하네스 (역할 라우팅: combo/main) | prompt 8,734 / completion 73,852 / cached 6,646 → total 82,586 | in $0.03 / out $0 / cacheRead $0 / cacheWrite $0 | $0.00006264 | $0.00002088 | 구독 쿼터 한계 유출 $0.00 (가정, 측정값 미포함) |

> **비용 캡션 (단가 가정 및 적용 근거)**: 모든 단가는 **사용자 제공 단가표, USD / 1M tokens** 기준이며, VAYEX 하네스는 원격 워커 모델이 클라이언트에서 관측되지 않아 결정 모델인 drex-max-v1.1 단가(in $0.03 / out $0.00)로 계상했습니다. deepseek-v4.1-flash-1017은 cacheWrite 단가가 없어 0으로 두었고, drex-max-v1.1은 output 단가가 $0.00 이므로 input 토큰 지출만 반영되어 행 전체가 0이 되지 않습니다. Codex(gpt-6.1-sol)는 완료된 실행이 없어 단가표가 있더라도 비용을 산출하지 않고 미측정으로 표기합니다.
> 
> 산식: (캐시 미적중 prompt 토큰 × input 단가 + 캐시 read 토큰 × cacheRead 단가 + cacheWrite 토큰 × cacheWrite 단가 + completion 토큰 × output 단가) ÷ 1,000,000. 비용/성공 과제는 총 공시 단가 비용 ÷ 3회 전부 통과한 과제 수입니다.

---
## 3. 성공 과제당 효율 (측정 토큰 기준)

| 환경 | 성공 실행 수 | 성공 과제 수(3회 전부 통과) | 성공 과제당 토큰 (median 합) | 공시단가 성공과제당 비용 |
|---|:---:|:---:|:---:|:---:|
| Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미측정(차단) | 미측정 | — | 미측정 |
| Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 12 | 4/4 | 3,395 | $0.002889 |
| DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 11 | 3/4 | 10,514 | $0.001222 |
| VAYEX 하네스 (역할 라우팅: combo/main) | 10 | 3/4 | 6,254 | $0.00002088 |

> 공시 단가 비용/성공 과제는 위 비용 표의 총 공시 단가 비용을 3회 전부 통과한 과제 수로 나눈 값이며, 토큰/성공과제는 응답 usage 에서 읽은 실측값이다.

---
## 4. 과제별 세부 실측치 (N=3)

| 과제 | 환경 | 성공 | 통과율 | 지연 median ± sd (ms) | TTFT median (ms) | 토큰 median | 실패 사유 |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| `task-a-single-line-fix` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미측정 | 미측정(차단) | — | — | 미보고 | rep1: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep2: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep3: Selected model is at capacity. Please try a different model. / Selected model is at capaci |
| `task-b-frontend-component` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미측정 | 미측정(차단) | — | — | 미보고 | rep1: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep2: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep3: Selected model is at capacity. Please try a different model. / Selected model is at capaci |
| `task-c-multifile-refactor` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미측정 | 미측정(차단) | — | — | 미보고 | rep1: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep2: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep3: Selected model is at capacity. Please try a different model. / Selected model is at capaci |
| `task-d-complex-debugging` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | 미측정 | 미측정(차단) | — | — | 미보고 | rep1: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep2: Selected model is at capacity. Please try a different model. / Selected model is at capaci<br>rep3: Selected model is at capacity. Please try a different model. / Selected model is at capaci |
| `task-a-single-line-fix` | Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 3/3 | 100.0% | 2460 ± 307.5281 | — | 1,135 | — |
| `task-b-frontend-component` | Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 3/3 | 100.0% | 20780 ± 2278.883 | — | 3,720 | — |
| `task-c-multifile-refactor` | Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 3/3 | 100.0% | 9965 ± 759.8294 | — | 2,043 | — |
| `task-d-complex-debugging` | Claude Opus 5.5, 원격 게이트웨이 경유 단일 모델 호출 (Claude CLI 미설치) | 3/3 | 100.0% | 42076 ± 2584.9488 | — | 6,680 | — |
| `task-a-single-line-fix` | DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 3/3 | 100.0% | 4072 ± 1636.1288 | — | 665 | — |
| `task-b-frontend-component` | DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 2/3 | 66.7% | 60417 ± 4696.1344 | — | 10,971.5 | rep1: 5/5 hidden tests failed: Renders title and value correctly; Applies correct status badge c |
| `task-c-multifile-refactor` | DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 3/3 | 100.0% | 38589 ± 13989.1637 | — | 6,046 | — |
| `task-d-complex-debugging` | DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | 3/3 | 100.0% | 140861 ± 29935.7083 | — | 24,830 | — |
| `task-a-single-line-fix` | VAYEX 하네스 (역할 라우팅: combo/main) | 3/3 | 100.0% | 5617 ± 1591.8959 | 2114 | 908 | — |
| `task-b-frontend-component` | VAYEX 하네스 (역할 라우팅: combo/main) | 3/3 | 100.0% | 96258 ± 19006.0854 | 1889 | 10,139 | — |
| `task-c-multifile-refactor` | VAYEX 하네스 (역할 라우팅: combo/main) | 3/3 | 100.0% | 70381 ± 17739.9529 | 1831 | 7,716 | — |
| `task-d-complex-debugging` | VAYEX 하네스 (역할 라우팅: combo/main) | 1/3 | 60.0% | 64490 ± 62901.0415 | 1805 | 9,298 | rep1: 3/5 hidden tests failed: Cancelled tasks clean up timers immediately; Listener count does <br>rep3: 3/5 hidden tests failed: Cancelled tasks clean up timers immediately; Listener count does  |

---
## 5. 실패 기록 (15건, 은폐 없이 전량 기록)

| 실행 ID | 환경 | 과제 | 반복 | 종류 | 사유 |
|---|---|---|:---:|---|---|
| `live_task-a-single-line-fix_codex-cli_rep1` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-a-single-line-fix` | 1 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-a-single-line-fix_codex-cli_rep2` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-a-single-line-fix` | 2 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-a-single-line-fix_codex-cli_rep3` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-a-single-line-fix` | 3 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-b-frontend-component_codex-cli_rep1` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-b-frontend-component` | 1 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-b-frontend-component_codex-cli_rep2` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-b-frontend-component` | 2 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-b-frontend-component_codex-cli_rep3` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-b-frontend-component` | 3 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-c-multifile-refactor_codex-cli_rep1` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-c-multifile-refactor` | 1 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-c-multifile-refactor_codex-cli_rep2` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-c-multifile-refactor` | 2 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-c-multifile-refactor_codex-cli_rep3` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-c-multifile-refactor` | 3 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-d-complex-debugging_codex-cli_rep1` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-d-complex-debugging` | 1 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-d-complex-debugging_codex-cli_rep2` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-d-complex-debugging` | 2 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-d-complex-debugging_codex-cli_rep3` | Codex CLI (원격 codex exec, 미측정 — 원격 제공자 유지보수/용량 초과) | `task-d-complex-debugging` | 3 | `transport_error` | Selected model is at capacity. Please try a different model. / Selected model is at capacity. Please try a different model. |
| `live_task-b-frontend-component_deepseek-v4.1-flash-1017_rep1` | DeepSeek V4.1 Flash 1017 (최소비용 기준 모델) | `task-b-frontend-component` | 1 | `hidden_test_failure` | 5/5 hidden tests failed: Renders title and value correctly; Applies correct status badge classes (success, warning, error); Includes accessible button toggle with aria-expanded attribute; CSS defines  |
| `live_task-d-complex-debugging_vayex-harness_rep1` | VAYEX 하네스 (역할 라우팅: combo/main) | `task-d-complex-debugging` | 1 | `hidden_test_failure` | 3/5 hidden tests failed: Cancelled tasks clean up timers immediately; Listener count does not increase per retry attempt; High concurrency 500 tasks stress test leaves 0 dangling listeners and timers |
| `live_task-d-complex-debugging_vayex-harness_rep3` | VAYEX 하네스 (역할 라우팅: combo/main) | `task-d-complex-debugging` | 3 | `hidden_test_failure` | 3/5 hidden tests failed: Cancelled tasks clean up timers immediately; Listener count does not increase per retry attempt; High concurrency 500 tasks stress test leaves 0 dangling listeners and timers |

---
## 6. 방법론 · 재현 절차 · 중단 규칙

- **과제 정의**: `scripts/lib/benchmark-tasks.mjs` 의 4개 과제를 그대로 재사용(문장·초기 파일 동일).
- **격리**: 실행마다 `scripts/lib/fixture-manager.mjs` 로 새 워크스페이스를 생성하고 초기 파일만 기록한 뒤, 실행 종료 후 삭제.
- **채점**: `scripts/lib/live-hidden-evaluator.mjs` 가 산출물을 실제로 import/실행하여 hidden test 를 검증한다. 에이전트의 자기 신고는 사용하지 않는다.
- **중단/재시도 규칙**: 실행별 타임아웃({"codex-cli":240000,"claude-opus-5-5":180000,"deepseek-v4.1-flash-1017":180000,"vayex-harness":300000}), 전송 계층 실패(5xx/타임아웃/네트워크)는 2초 간격 1회 재시도, 연속 5회 전송 실패 시 중단 후 나머지 슬롯도 실패로 기록.
- **부분 결과 보존**: 슬롯 하나가 완료될 때마다 JSON 을 즉시 덮어써 장시간 실행 중 손실을 막는다.
- **측정값 vs 가정값**: 지연(wall-clock), TTFT, 토큰량, 통과율은 **측정값**이다. 구독 등가 비용 $0.000000 과 그 라벨은 **가정 유도값**이며, 공시 단가 비용은 단가표 부재로 **미공개**다.
- **단가 근거**: 원격 ~/.opencodex/config.json 의 provider authMode 및 modelProfile 을 근거로 판정. 공식 1M 토큰 단가표가 존재하지 않는 모델은 비용을 추정하지 않고 "미공개(구독/무과금 티어)"로 표기한다.

### 근거 파일 (원격)

- `[REDACTED_REMOTE_PATH]` — provider/authMode/models/combos
- `[REDACTED_REMOTE_PATH]` — 코드 CLI 모델 및 노력도 기본값
- `[REDACTED_REMOTE_PATH]`, `spend-ledger.jsonl` — 게이트웨이 사용량/정산 원장(라우팅 확인용)
