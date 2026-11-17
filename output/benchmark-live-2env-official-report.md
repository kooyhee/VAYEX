# Live 2-환경 실측 벤치마크 — 공식 단가 기준 비용 (공정 과제 세트)

- 실행 구성: Claude 12 슬롯은 `node scripts/benchmark-live-2env-official.mjs -n 3`, VAYEX 12 슬롯은 라우팅 대상 회수를 포함한 `node scripts/benchmark-live-2env-official.mjs --env=vayex-harness -n 3 --out=<scratch>\vayex-routed.json --md-out=<scratch>\vayex-routed.md` 로 수집했다(같은 과제 세트·같은 hidden test).
- 시작 2026-11-08T21:34:52.653Z · 종료 2026-11-08T22:11:24.595Z · 슬롯 24/24
- 과제: `scripts/lib/benchmark-tasks.mjs` 4개 과제 × N=3, 정정된 프롬프트(`promptCorrected`)와 동일한 hidden test(`scripts/lib/live-hidden-evaluator.mjs`)를 사용했다. 실행마다 격리 워크스페이스를 새로 만들고 응답 파일을 기록한 뒤 hidden test를 실제 실행했다.
- 전송: 두 환경 모두 `POST {gateway}/chat/completions` SSE 스트림. Claude는 단일 모델 호출, VAYEX는 원격 역할 라우팅 `combo/main` 1회 호출.
- 비용 단가: Claude Opus 5.5 input $4.00 / output $20.00 / cache read $0.20 / cache write $5.00 per 1M tokens(https://docs.claude.com/en/docs/about-claude/pricing). VAYEX는 실행별 라우팅 대상을 게이트웨이 관리 API로 회수해(§3) DeepSeek 라우팅은 `deepseek-v4.1-flash-1017` off-peak(cache-miss in $0.15 / cache-hit $0.003 / out $0.60 per 1M, https://api-docs.deepseek.com/quick_start/pricing), Claude 라우팅은 Anthropic 단가, Gemini 라우팅은 Gemini 3.8 Flash 표준 단가(in $0.75 / out $3.75 / cache read $0.075 per 1M, https://ai.google.dev/gemini-api/docs/pricing)로 계산했다. 이전 사용자 제공 단가표와 drex-max-v1.1 $0.03/1M 단가표 항목은 사용하지 않았다.

## 1. 환경별 결과

| 환경 | 모델 | 실행 | 성공 | 성공률 | 성공 실행 완료시간 중앙값 (ms) | TTFT 중앙값 (ms) | 3회 전부 통과 과제 |
|---|---|---:|---:|---:|---:|---:|---:|
| Claude Opus 5.5 (게이트웨이 단일 모델 호출, 에이전트 CLI 미실행) | `anthropic/claude-opus-5-5` | 12 | 12 | 100.0% | 24361 | 3414 | 4/4 |
| VAYEX 하네스 (원격 역할 라우팅 combo/main) | `combo/main` | 12 | 12 | 100.0% | 46205 | 3953.5 | 4/4 |

## 2. 모델별 측정 토큰 합계

| 환경 | 모델 (응답이 보고한 id) | 측정 실행 | input | output | cache read | cache write | total |
|---|---|---:|---:|---:|---:|---:|---:|
| Claude Opus 5.5 (게이트웨이 단일 모델 호출, 에이전트 CLI 미실행) | `anthropic/claude-opus-5-5` | 12 | 9240 | 59469 | 8064 | 미보고 | 68709 |
| VAYEX 하네스 (원격 역할 라우팅 combo/main) | `combo/main` | 12 | 9240 | 63856 | 8064 | 미보고 | 73096 |

## 3. 공식 단가 비용

| 환경 | 과금 근거 (측정값) | 공식 단가 | 총 비용 | 성공 과제당 비용 |
|---|---|---|---:|---:|
| Claude Opus 5.5 (게이트웨이 단일 모델 호출, 에이전트 CLI 미실행) | input 9240 / output 59469 / cache read 8064 토큰 | in $4 / out $20 / cacheRead $0.2 per 1M | $1.19569680 | $0.29892420 |
| VAYEX 하네스 (원격 역할 라우팅 combo/main) | input 9240 / output 63856 / cache hit 8064 토큰 | 실행별 라우팅 대상 단가 (§3) | $0.06620712 | $0.01655178 |

산식: (캐시 미적중 input × input 단가 + cache hit × cache-hit 단가 + output × output 단가) ÷ 1,000,000. input은 cache read를 포함한 prompt 토큰이므로 미적중분만 input 단가를 적용했다. 성공 과제당 비용은 총 비용 ÷ (3회를 모두 통과한 과제 수). cache write는 전송 계층이 보고한 값이 없어(0으로 채우지 않고 미보고) 비용에 반영하지 않았다.

### VAYEX 라우팅 대상 회수와 비용 배정

`combo/main` 요청의 SSE `model` 필드는 요청한 별칭만 되돌려준다. 실행별 응답 헤더 `x-opencodex-request-id` 를 기록하고 게이트웨이 관리 API `GET http://49.173.53.4:10100/api/request-history/{requestId}/route-decision` (무인증)로 실제 채택 모델을 회수했다. 이번 실행의 라우팅 결과:

| 라우팅 대상 | 실행 수 | input | output | cache hit | 적용 단가 | 비용 |
|---|---:|---:|---:|---:|---|---:|
| `opendesign/deepseek-v4.1-flash-eco` | 10 | 7964 | 55136 | 7040 | deepseek-v4.1-flash-1017 off-peak (cache-miss in $0.15 / cache-hit $0.003 / out $0.60 per 1M) | $0.03324132 |
| `google-antigravity/gemini-3.8-flash` | 2 | 1276 | 8720 | 1024 | Gemini 3.8 Flash 표준 (in $0.75 / out $3.75 / cache read $0.075 per 1M) | $0.03296580 |

비용 비중: `opendesign/deepseek-v4.1-flash-eco` 50.2% · `google-antigravity/gemini-3.8-flash` 49.8%

DeepSeek 라우팅 단가는 `deepseek-v4.1-flash-1017`(API id `deepseek-flash`, 모델 버전 DeepSeek-V4.1-Flash-1017) off-peak 공식 단가다(https://api-docs.deepseek.com/quick_start/pricing). 이번 실행 구간(2026-11-08 UTC)은 off-peak이며 peak는 정확히 2배(01:00-04:00·06:00-10:00 UTC 평일)다.

무효화된 단가: 프로젝트 단가표 `scripts/lib/live-environments.mjs:96-101`의 drex-max-v1.1 $0.03/1M input은 공식 발표($0.06/1M input, output 미과금, nace.ai/drex)의 절반이라 사용하지 않았고, `output/official-api-pricing.json`의 drex 행(1,000 결정당 $0.03)은 토큰 단가가 아니므로 이 벤치마크 산식에 쓰지 않았다. 이전 보고서의 사용자 제공 단가 기반 비용은 전부 대체된다.

### 하네스 세션의 `usage.cost` 필드

하네스 세션 JSONL의 assistant 레코드는 `usage.cost`를 갖지만 값은 `{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}`이다(예: `app/data/agent/sessions/-Desktop-랩실-40_AI보고서-app/2026-11-08T17-24-16-248Z_01a1bc30-....jsonl`). 이는 omp가 `models.yml`의 모델 가격표로 계산한 값이며, 생성된 `models.yml`( `app/lib/inference.mjs` `prepareRuntime`)에는 가격 항목이 없다. UI 집계(`app/public/protocol.js:271` `noteUsage`, `app/public/activity.js:118`)와 `app/public/app.js:1501` 이후 표시는 이 `usage.cost`를 그대로 합산한다. 실제 게이트웨이 응답의 `usage` 객체에는 cost 필드가 존재하지 않는다(probe: `{"prompt_tokens":281,"completion_tokens":2,"total_tokens":283,...}`). `app/test/activity.test.mjs:110` 은 `cost:0.002`를 넣은 고정 픽스처로 집계 로직만 검증하며 게이트웨이가 USD를 보고한다는 근거가 아니다. 결론: 게이트웨이는 호출별 USD를 보고하지 않고, 워커/`combo/*` 단계의 `usage.cost`는 채워지지 않는다(0).

## 4. 실패 기록

실패 없음.

## 5. 재현과 한계

- 재시도/중단: 전송 계층 실패(5xx/타임아웃/네트워크) 1회 재시도(2초 간격), 연속 5회 실패 시 남은 슬롯을 실패로 기록. per-run 타임아웃 {"claude-opus-5-5":240000,"vayex-harness":300000}.
- 지표는 wall-clock(ms), 토큰량, hidden test 통과 수 전부 실측값이다. 추정·보간한 값은 없다.
- 두 환경 모두 게이트웨이 HTTPS(443) 경유이며 Claude CLI/Codex CLI 실행이 아니다. 원격 호스트 SSH는 이번 측정에서 사용하지 않았다(포트 22 연결이 재설정됨).
- 원자료: `output/benchmark-live-2env-official-result.json` (실행별 측정 토큰·결정 수·실패 원문 포함).