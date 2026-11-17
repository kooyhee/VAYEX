# GPAI 벤치마킹 — 용도별(모드별) 최적화 설계의 실물 사례 분석

**문서 목적:** 요청 문구 *"용도별 최적화 설계도 진행 (대상이 바이브 코더/학생이므로, 코딩, 학습 등 각각 최적화 설계 포함 : gpai 참고)"* 에서 지목한 **gpai**의 실체를 확인하고, 그 제품에서 **우리 제품(사용자 대상 zero-config AI 코딩/학습 어시스턴트)으로 옮길 수 있는 설계 아이디어만** 분리해 정리한다.

**작성일 / 모든 URL 접근일:** 2026-11-04 (KST)
**근거 등급 표기:**
- `[1차]` = 벤더 공식 페이지·공식 릴리스노트·이용약관 (벤더가 직접 쓴 것)
- `[2차]` = 언론 보도·제3자 분석
- `[UGC]` = 앱스토어 사용자 리뷰 (일화, 통계 아님)
- `[미확인]` = 공개 자료로 검증 불가. **벤더 주장이며 우리 제품의 사실로 취급하지 않는다.**

> **방법상 한계 (먼저 밝힘):** `gpai.app`의 기능 화면(`/agent`, `/solver`, `/chat`, `/visualizer`, `/drive`, `/problem-generator`, `/slide`, `/pricing`)은 **전부 로그인 필수(login_required)** 로 응답해 내부 UI·프롬프트·라우팅을 직접 열람하지 못했다. 따라서 아래 "모드 분리" 기술의 근거는 ①공개 제품 소개 페이지 ②공개 릴리스노트("What's new") ③앱스토어/플레이스토어 등록 문구 ④이용약관 ⑤언론 보도이며, **제품 내부 동작은 관찰이 아니라 문서 기술에 기반한 재구성**이다. 관찰로 확인한 것과 문서로만 확인한 것을 항목별로 구분해 표기한다.

---

## 1. "gpai"가 무엇인가 — 후보 전수와 판정

### 1.1 실제로 존재하는 후보

| # | 후보 | URL | 무엇인가 | 문맥 적합성 |
|---|---|---|---|---|
| A | **GPAI: AI-ce your studies / GPAI: 학점 상승 AI** (Turing Inc. = (주)튜링, 서울) | https://gpai.app/ , https://play.google.com/store/apps/details?id=com.gpai.app , https://apps.apple.com/kr/app/gpai-%ED%95%99%EC%A0%90-%EC%83%81%EC%8A%B9-ai/id6748109514 | 대학생용 AI 학습 에이전트. 2025년 8월 인도 출시 → 2025-09-30 미국·앱스토어 출시 → 2025년 10월 한국·일본 진출 `[2차]`. 문제풀이(Solver)/시각자료(Visualizer)/채팅(Chat) 3개 표면 + 문제 생성기·AI Drive·슬라이드 제작 | **적합.** "용도별 최적화"의 실물 사례. 단 **코딩 도구가 아니라 학습 도구**다 |
| B | **Global Partnership on Artificial Intelligence (GPAI)** — OECD 통합 파트너십 | https://www.oecd.org/en/about/programmes/global-partnership-on-artificial-intelligence.html , https://oecd.ai/en/about/about-gpai | 2020-06-15 출범, OECD가 호스팅하는 **국제 AI 정책 이니셔티브**(회원국 44~46개국 + EU) | **부적합.** 정책 기구이며 제품 설계 참조가 될 수 없다 |
| C | **"GPAI" = General-Purpose AI (범용 AI)** — EU AI Act / EU GPAI Code of Practice 용어 | https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai | 규제 용어. 제품명이 아님 | **부적합.** 이름 충돌의 주 원인 |
| D | **G-P AI** (Globalization Partners) | https://www.globalization-partners.com/ai-in-hr/ | HR/글로벌 고용 컴플라이언스 AI. 표기만 유사 | **부적합** |

추가로 검색된 "GPAI AI" 류 유튜브·Softonic·미러 배포 페이지는 모두 후보 A의 재배포/홍보물이며 별개 제품이 아니다. **"gpai"라는 이름의 코딩 에이전트/IDE/바이브코딩 도구는 존재하지 않는 것으로 확인됐다** (검색 결과의 "GPAI" 언급은 전부 EU AI Act 규제 용어 문맥).

### 1.2 판정

- 요청자가 말한 **gpai = 후보 A, 튜링의 대학생용 학습 AI 에이전트**로 판단한다. 근거: (i) 요청 문구가 "학생" 대상이고 "학습" 축을 함께 언급, (ii) 해당 제품의 마케팅 언어가 정확히 *"STEM 분야에 최적화된 올인원"*, *"STEM 학습에 특화된 프리셋과 자동화된 워크플로우"*, *"사용자별 학습 패턴에 맞춘 사용자 경험"* `[2차, 플래텀 2025-08-28]` — 즉 **용도별 최적화가 제품의 자체 정의**다.
- **단, 조용히 단정하지 않기 위해 명시한다:** 후보 A는 **학습 전용** 제품이며 코딩 기능이 없다. 따라서 "코딩 최적화" 축은 gpai에서 직접 가져올 수 없고, gpai에서 가져올 수 있는 것은 **"모드를 나누는 방식"이라는 구조**뿐이다(§3·§4).
- **후보 B(OECD/GPAI 정책 기구)는 실제 존재하는 강한 이름 충돌이지만 설계 참조가 아니다.** 만약 요청자가 이것을 가리킨 것이라면 참조할 제품 설계 자체가 없으므로, 그 경우 이 문서의 §3~§4는 근거를 잃는다.

---

## 2. GPAI가 실제로 "모드를 나누는" 방식 (구체 기술)

### 2.1 모드의 단위 = 산출물(artifact)의 종류

GPAI는 "코딩 모드/학습 모드"처럼 **인지 과업**으로 나누지 않고, **만들어 내는 결과물의 종류**로 나눈다. 2026-06-23 릴리스노트가 이를 명시한다 `[1차]`:

> "Meet Problems, Visuals, and Chat — GPAI, rebuilt around its core … We reworked the entire interface … **You can switch between the three from a single switcher at the top, and each one opens on its own home screen** so you can get started right away."

| 표면 | 산출물 | 고정된 출력 형식 | 전용 도구 |
|---|---|---|---|
| **Problems** (구 Solver) | 단계별 풀이 + 그림 | 단계별/서술형/손글씨 스타일 중 택1, 그림 동반, PDF·DOCX·LaTeX·PNG 내보내기 | 다중 모델 교차검증, 병렬 문제 생성기(변형 문제) |
| **Visuals** (구 Visualizer) | 편집 가능한 벡터 그림 | SVG / TikZ `.tex` 소스, 스타일 7종(일러스트·그래프·순서도·다이어그램·회로·화학·논리) + 2026-10-29 추가 3종(기구·지도·타이밍 다이어그램) | TikZ 엔진, Chemistry(RDKit) 엔진, 캔버스/버전관리/이미지 편집기, 82,114개 아이콘 라이브러리 `[1차]` |
| **Chat** | 대화형 답변 + 부산물 | 산문 + 인라인 그림 + 코드 실행 결과 파일 | 웹 검색, 이미지 생성, 코드 실행(Python/shell), Deep Explain, 논문 DOI 검증 |

이 표의 핵심은 **"모드 = 서로 다른 출력 계약(output contract)"** 이라는 점이다. 같은 질문이라도 Problems에서는 "풀이 과정", Visuals에서는 "그림", Chat에서는 "설명 산문"이 나온다. 사용자는 무엇을 받을지 모드 선택만으로 알 수 있다.

### 2.2 모드 간에 실제로 무엇이 달라지는가

| 층위 | 관찰/문서 근거 | 확인 등급 |
|---|---|---|
| **시스템 프롬프트** | 공개되지 않음. "proprietary Chain of Thought (CoT) technique", "STEM reasoning에 특화 튜닝" 주장만 존재 | `[미확인]` 벤더 주장 |
| **모델** | **표면별 모델 허용목록이 다르다.** 릴리스노트가 모델별 적용 범위를 명시: "GPT-5.6 Luna — In **Solver and AI Chat**"(Visualizer 제외), "MiniMax M3 — In **AI Chat**"(단독), "DeepSeek V4 Pro — In AI Chat", "GPT-5.6 Sol/Terra — In Solver, AI Chat, and **chemistry figures in Visualizer**". Visualizer는 스타일별 모델군(Nano Banana, GPT Image, Gemini, Claude, Grok)에 **"Best" 태그**를 붙이고 여러 모델을 **나란히 렌더해 비교** | `[1차]` |
| **도구 집합** | Chat만 웹검색·코드실행·이미지생성 보유. Problems만 교차검증·문제변형 보유. Visuals만 TikZ/RDKit·캔버스·버전관리 보유 | `[1차]` |
| **컨텍스트 전략** | 공통 저장소(AI Drive)에서 **참조로 끌어오기**: "Every file in AI Drive is available to the rest of GPAI. Wherever you'd normally upload … there's now a **Choose from AI Drive** option". 열람 중인 **파일·페이지가 암묵 컨텍스트**: "It already knows which file you have open and which page you're on, so 'explain this part' works without pasting anything in." 문장/셀 드래그 인용, 다중 파일 동시 선택 | `[1차]` |
| **출력 형식** | 표면별로 내보내기 형식이 고정(Problems: PDF/DOCX/LaTeX/PNG, Slides: PPTX/PDF, Visuals: SVG/`.tex`) | `[1차]` |
| **UI** | 상단 단일 스위처 + 표면별 자체 홈 화면. Visuals는 캔버스형, Problems는 결과 중심 재설계, Chat은 대화형 | `[1차]` |
| **비용/한도** | **표면마다 크레딧 소모가 다르다**: Solver의 Visuals 선택자 "None(가장 빠름) / Standard / **Premium — uses significantly more credits**". 요금제는 Free 대비 "3×/20×/40× 일일 사용량"이라는 **상대 배수**로만 표기 | `[1차]` (배수의 절대량은 `[미확인]`) |

### 2.3 모드는 어떻게 선택되는가 — 자동·수동의 혼합

GPAI는 "완전 자동"도 "완전 수동"도 아니다. **층위별로 다르게 배분**한다.

**자동(사용자가 고르지 않음):**
- 업로드 자료에서 **문제 경계를 자동 검출**해 문제별로 분리: "GPAI detects each question" / "finds each problem inside the file and writes a matching variation" `[1차]`
- Chat의 **도구 자동 선택**: "the search kicks in when current info is needed", "It picks the right format — plots for data, flowcharts and UML for systems, circuit diagrams", "Chains tools in one turn — search → read → draw" `[1차]`
- Visualizer/Figure Generator의 **스타일 Auto**: "If you leave it on Auto, GPAI picks one of these when your prompt fits" `[1차]`

**수동(사용자가 명시 선택):**
- 상단 스위처의 표면 전환(Problems/Visuals/Chat) — 항상 수동
- 모델 피커("Open the model list and pick the one that fits") — 선택사항, 기본값 존재
- 문제 변형 전략: "pick a variation strategy problem by problem, or set one and hit **Apply to all**" `[1차]`
- Solver의 Visuals 등급(None/Standard/Premium), 문제 유형·난이도·개수·해설 포함 여부 `[1차]`
- 슬라이드 템플릿·스타일

**애매할 때 되묻기(자동이 실패한 지점):**
- "**Asks when it's unsure** — if your question is ambiguous, it pops a short form to clarify instead of guessing" `[1차]`

> **설계상 의미:** GPAI의 자동화는 *분류*가 아니라 *후보 생성과 파라미터 채우기*에 쓰이고, **최종 선택지는 사용자에게 노출**한다. 반대로 "어떤 모델이 답했는가"는 노출하지 않는다(아래).

### 2.4 의도적으로 감추는 것 / 의도적으로 드러내는 것

**감추는 것 (블랙박스로 두는 층):**
1. **교차검증의 실제 내부.** 마케팅은 "검증을 통과한 답만 보여드립니다"이지만, 화면에는 통과/탈락한 모델별 답이 나열되지 않는다(공개 문서 기준). **모델 간 불일치가 있을 때 무엇을 사용자에게 보여주는지는 `[미확인]`.**
2. **모델 라우팅·티어 결정 로직.** 모델 피커는 있으나 "이 요청에 실제로 어느 모델이 얼마나 쓰였는가"는 노출되지 않는다.
3. **크레딧 소모의 절대량.** "significantly more credits", "20× the daily usage"처럼 **상대 표현만** 제공. 사용자는 한 작업의 실제 원가를 알 수 없다.
4. **프롬프트/시스템 지시문.**

**드러내는 것 (의도적 노출 = 제품 차별점으로 내세우는 층):**
1. **생성 전 개요/파라미터 확인.** 사내 표현으로 **"공개형 인터랙션"**: "You see the outline first — Fix the order and the wording while it's still a few lines of text, not twenty finished slides" `[1차]`. 언론도 이를 차별점으로 받아 적었다 `[2차, AI타임스/벤처스퀘어 2026-09-22]`: *"기존 범용 AI는 결과물이 나오기 전까지 작업 과정을 확인할 수 없어 … GPAI는 결과물을 한 번에 생성하는 대신, 사용자가 원하는 방향을 먼저 확인하고 고를 수 있다."*
2. **그림의 소스 코드.** "See the source code — switch between the rendered image and the exact code that created it, with syntax highlighting", TikZ `.tex` 원본 제공 `[1차]`.
3. **추론 과정 자체를 결과물로.** 단계별 풀이, Deep Explain, 그리고 문제 변형에서 "what changed between the original and the variation"의 side-by-side 비교 `[1차]`.
4. **검증된 출처.** "Give it a paper title or DOI and it checks that the paper actually exists before citing it, and warns you when something doesn't match" `[1차]`.

---

## 3. 전이 가능 / 불가 분류

요청자의 제품 원칙(**"실행 증거 없는 주장 금지"**)에 따라, 벤더의 성능 주장은 설계 근거에서 배제하고 **구조만** 취한다.

### 3.1 (a) 전이 가능한 설계 패턴

| ID | 패턴 | GPAI에서의 실물 | 우리 제품으로의 번역 | 왜 전이 가능한가 |
|---|---|---|---|---|
| **T1** | **산출물 단위 표면 분리 + 단일 스위처** | Problems/Visuals/Chat, 각자 자신의 홈 화면 | `코드 작업` / `개념 학습` 2표면 + 상단 1개 스위처. 각 표면은 첫 화면이 다르다(코드: 변경 대상·실행 버튼 / 학습: 자료·질문) | 인지 과업이 아니라 **출력 계약**으로 나누므로 과업이 늘어나도 축이 흔들리지 않는다 |
| **T2** | **표면별 모델 허용목록(allowlist)** | GPT-5.6 Luna는 Solver·Chat만, MiniMax M3는 Chat만, Sol·Terra는 Visualizer 화학 그림에만 | 코딩 표면: 코드 생성/패치 특화 모델 + 로컬 GGUF. 학습 표면: 설명·긴 문맥 모델. **양쪽에 다 넣지 않는다** | 모델 1개를 만능으로 쓰지 않으면서도 제품은 1개로 유지된다. 이미 우리 설계서의 4-Tier 라우팅과 정합 |
| **T3** | **Auto 기본 + 명시적 탈출구** | "Stick with Auto if you don't care which model runs" / 스타일 Auto / 모델 피커 | 기본은 자동 배정, 화면 한쪽에 "이번만 바꾸기" 1개 버튼. **설정 화면은 만들지 않는다** | zero-config 요구와 정확히 일치. 자동화의 오분류 리스크를 사용자 1클릭으로 흡수 |
| **T4** | **적용 후 확인 게이트 (공개형 인터랙션)** | 슬라이드 아웃라인 선확정, 변형 전략 선택, 유형·난이도 선택, 애매하면 Clarify 폼 | 코딩: 패치 적용 후 **변경 내역 확인 및 되돌리기**. 적용 전 승인 단계는 두지 않는다. 학습: 설명 전 **목차/풀이 단계 골격** 확인 | 변경 내역이 곧 되돌리기 판단의 근거가 되므로, 승인 단계 없이도 실행 증거 원칙과 충돌하지 않는다 |
| **T5** | **공유 자료 저장소 + 참조 첨부** | AI Drive의 `Choose from AI Drive`, 열람 중 파일·페이지가 암묵 컨텍스트, 문장/셀 인용 | 학습: 업로드 자료를 저장소화하고 `@` 참조. 코딩: 리포/열람 중 파일·심볼이 암묵 컨텍스트 | "매번 같은 파일 다시 첨부" 마찰 제거는 도메인 무관 |
| **T6** | **깊이 다이얼(비용 노출형)** | Solver Visuals: None / Standard / Premium(크레딧 대량 소모 명시) | 학습: `요약 / 표준 / 심화(교차검증 포함)`. 코딩: `빠른 패치 / 테스트까지 / 교차검토까지` | 품질-비용 트레이드오프를 **사용자 언어로** 노출. 단, 우리는 배수가 아니라 예상 호출 수/토큰을 수치로 보여준다 |
| **T7** | **불일치를 신뢰 신호로 승격** | "discrepancies are flagged", "warns you when something doesn't match" | 코딩: 테스트 실패·린트 경고·2차 모델 이견을 **답변 최상단 배지**로. 학습: 계산 재유도 결과 불일치를 배지로 | "모델 3개 합의"보다 "불일치 시 경고"가 훨씬 싸고 정직하다 |
| **T8** | **산출물의 원본 소스를 사용자에게 개방** | 그림의 TikZ/`.tex`, 코드 뷰 토글 | 코딩: 생성된 패치와 실행한 명령·exit code 원문 노출. 학습: 인용한 자료의 페이지·문장 원문 노출 | 실행 증거 원칙의 UI 구현형. "믿어달라" 대신 "보라" |
| **T9** | **하나의 산출물 → 두 소비자용 렌더** | 같은 문제 구조로 학생용 변형문제 / 교사용 시험지 버전 | 같은 리포 상태로 사용자용 "직접 수정하기" 과제 / 채점용 정답 diff | 콘텐츠 재생산 비용 없이 난이도·대상만 변경한다 |
| **T10** | **동기화 기반 수동 알림** | 강의 포털 연동 → "오늘의 브리핑"(마감·시험 D-n) | 코딩: 미해결 테스트/빌드 실패를 앱 시작 시 1줄 브리핑. 학습: 다가오는 과제·복습 큐 | zero-config의 "물어보지 않아도 알려줌" 축. 단 §3.2의 연동 부담을 피해 **로컬 상태에서만** 생성 |

### 3.2 (b) 벤더 고유 구현 세부 — 그대로 옮기면 안 되는 것

| 항목 | 왜 전이 불가/부적합인가 |
|---|---|
| **TikZ 엔진 + RDKit 화학 엔진 + `R₁ ≅ R₀`(해법 경로 동형) 변형 생성기** | STEM 도해·분자구조 전용 공학. 우리 도메인(코딩/학습)에는 대응 산출물이 없다. 또한 "변형 문제의 해법 경로가 동형"이라는 보장은 **벤더 자체 주장이며 독립 검증 없음** `[미확인]` |
| **문제 1건당 3개 상용 모델 동시 호출(교차검증)** | 제품 파이프라인이라기보다 **원가 구조 선택**. 3중 호출은 지연·비용을 3배로 만든다. 우리는 "불일치 시에만 2차 호출"로 축소해야 한다(§4.3) |
| **LearningX/Blackboard/Coursemos 등 LMS 자격증명 연동** | 한국 대학별 통합·자격증명 보관·약관 리스크. 개인 프로젝트 범위를 넘는다. 필요하면 **파일 업로드 + 폴더 규약**으로 대체 |
| **AI Drive 파일 호스팅, 실시간 공동편집, PPTX/HWPX 편집기** | 스토리지·동시편집·오피스 호환은 별도 제품급 인프라. 우리 요구사항(코딩/학습)에 필수 아님 |
| **크레딧/요금제 포장(Free 대비 3×/20×/40×, Family Plan, 좌석 과금)** | 상업 패키징. 설계 참조 아님. 특히 **"20×"처럼 절대량을 숨기는 표기는 우리 제품에서 채택 금지**(§4.5) |
| **"Proprietary CoT"** | CoT 자체는 공개 기법이다. "STEM에 특화 튜닝했다"는 부분만 벤더 고유 주장이며 `[미확인]`. 이름만 모방할 가치 없음 |

### 3.3 (c) 메커니즘 없는 마케팅 주장 — 인용은 하되 사실로 쓰지 않는다

| 주장 (원문) | 출처 | 판정 |
|---|---|---|
| "**검증을 통과한 답만** 보여드립니다" / "keeps only what survives the cross-check" | 앱스토어·플레이스토어 등록 문구 `[1차]` | **자사 약관과 모순.** 같은 회사 이용약관 §10: "AI-generated content **may contain errors and should be independently verified**", "**Never rely solely on GPAI** for high-stakes academic decisions". → 마케팅 문구를 설계 근거로 채택 불가 |
| "자체 개발한 추론 최적화 기술과 시각화 엔진을 통해 **환각 현상을 극복**" | 연합뉴스 2026-04-02 `[2차]`, 회사 발표 인용 | **메커니즘·측정치 없음** `[미확인]`. "극복"은 반증 불가능한 표현 |
| "**the only solver in 2026** that makes cross-model verification a standard part of every query" | 자사 블로그 2026-06-17 `[1차]` | **자사 비교표 안에서만 참인 주장.** 제3자 검증 없음 `[미확인]` |
| 교차검증 대상이 "**GPT, Claude, Gemini**" (블로그) vs "**GPT-5, Gemini 2.5, DeepSeek R1**" (제3자 분석) vs "**여러 AI 모델**" (스토어) | 각각 gpai.app/s/content/... , doinghun.com , 앱스토어 | **벤더 진술 자체가 시점별로 불일치** `[미확인]`. 어느 것이 현재 구현인지 공개 자료로 확정 불가 |
| JEE Advanced 2025에서 **360점 만점에 351점** | teamturing.com 연구 섹션 `[1차]` | 회사 자체 채점 `[미확인]`. 독립 감사 없음 |
| "Loved by **200,000+ learners**" (랜딩) vs "**150만** 가입자" (회사 연혁·보도) vs "**1M+** downloads" (플레이스토어) | 각 페이지 `[1차]` | **분모가 다른 수치의 혼용.** 가입자/MAU/다운로드를 같은 서사에 섞음 `[미확인]` |
| "유료화 2개월 만에 매출 **830%**↑", "미국 **415개 대학** 사용" | 연합뉴스, teamturing `[1차]/[2차]` | 증가율의 기준값 미공개, "대학에서 사용"≠기관 계약. 제3자 분석도 같은 유보를 단다 `[2차, doinghun 2026-09-07]` |

**반증 가능한 부정 신호도 함께 기록한다** (설계 리스크용):
- 플레이스토어 리뷰: 최신 웹검색을 활성화해도 **날짜를 2024-05-22로 답하고 개정 법령을 구버전으로 안내**한다는 불만 `[UGC]` → "출처 기반"을 표방하는 제품에서도 **컨텍스트 신선도는 자동으로 보장되지 않는다.**
- 다수 리뷰가 **스트리밍 지연/입력 지연**을 보고 `[UGC]` → 다중 모델 교차검증·도해 생성의 지연 비용이 실제 UX에 드러난 사례.
- 제3자 분석의 지적: 다수결 합의는 **상관된 오류**를 잡지 못하며 수학적 증명을 대체하지 않는다 `[2차]`.

---

## 4. 우리 제품(한국 공학 분야 사용자 대상 zero-config 코딩/학습 어시스턴트) 설계 함의

전제: 기존 설계서(`40_AI보고서/설계문서/시스템_아키텍처_및_상세설계서.md`)의 **간편 모드(Zero-Config Default) + 4-Tier 하드웨어 적응 + 결정론적 오케스트레이터**를 유지하고, 그 위에 **용도 축**을 추가한다. gpai에서 가져오는 것은 §3.1의 T1~T10뿐이다.

### 4.1 가장 중요한 결론: gpai를 그대로 베끼면 요구를 놓친다

- gpai의 분리 축은 **"산출물 종류"**(문제풀이/그림/대화)다.
- 요청자가 필요한 축은 **"인지 계약"**이다 — *돌아가는 코드를 만든다*(코딩) vs *이해를 만든다*(학습). 둘은 산출물이 아니라 **성공 판정 기준**이 다르다.
- 따라서 **T1(표면 분리)은 형식만 차용하고, 분리 기준은 우리 도메인 것으로 새로 정의**해야 한다. 이것이 gpai 벤치마킹의 실질적 수확이다.

### 4.2 두 모드의 계약 차이 (구체 표)

| 축 | **코딩 모드** | **학습 모드** |
|---|---|---|
| **성공의 정의** | 실행된 테스트/빌드가 통과함 (증거 = exit code, 로그) | 학습자가 **다음 문제를 스스로 풀 수 있음** (증거는 자동 측정 불가 → 대체 지표: 자가 점검 문항 통과, 인용 근거 제시) |
| **진입 판단(자동 분류)** | 요청에 *변경 대상*(파일·심볼·에러 메시지·"고쳐/추가해/리팩터") 포함 | 요청에 *이해 대상*("왜", "설명", "이게 뭐야", "예제로", "시험 범위") 포함. 또는 자료 업로드 존재 |
| **모델** | 기본: 저비용 코드 모델(예: 설계서의 `deepseek-v4.1-flash`) → 2회 연속 실패 시에만 플래그십 승격. 로컬 Tier 1~3 GGUF로 오프라인 처리 | 기본: 설명·긴 문맥 모델. **수치·계산 항목에만** 2차 모델 재유도. 서술형 설명에는 다중 호출 금지 |
| **컨텍스트** | 파일시스템 + git 상태 + **AST 심볼 슬라이싱** + 테스트/빌드 명령 이력(마이크로 스킬). 강의자료는 넣지 않는다 | 사용자 업로드 자료(강의 PDF·필기·기출) + **페이지·문장 앵커**. 리포는 넣지 않는다. 파일은 **참조로 첨부**(복사 아님, T5) |
| **도구 집합** | 쓰기/실행 도구 **필수**(패치 적용, 셸, 테스트 러너, 린터). 검색 도구 선택 | 자료 파서·인용 추출·문제 생성기. **파일 쓰기/셸은 기본 차단**(오작동·표절 리스크). 코드 실행은 "계산 확인" 용도로만 샌드박스 |
| **출력 형태** | **diff/patch + 실행한 명령 + 결과**. 산문 최소화. 변경한 심볼 목록 첨부 | **단계 골격 + 근거 인용(자료명·페이지·원문 문장) + 자가 점검 질문**. 최종 정답은 접힘 상태로 |
| **상호작용** | 질문 최소화, 즉시 실행(Fast-Path). **단, 패치 적용 후 변경 내역 확인 및 되돌리기**(T4) 1회. 애매하면 파일 후보 2~3개를 버튼으로 제시하고 **설정 화면은 열지 않는다** | 먼저 **예측/시도 요구**(소크라테스 게이트) → 막힌 지점만 설명. 자료에 없으면 "자료에 없음"을 명시하고 웹 근거를 **분리 표기** |
| **깊이 다이얼** | `빠른 패치 / 테스트까지 / 교차검토까지` | `요약 / 표준 / 심화(재유도·교차검증 포함)` — 다이얼마다 **예상 호출 수·토큰·로컬/클라우드**를 수치로 표시(gpai의 "20×" 같은 배수 표기 금지) |
| **검증** | 실행 증거 없으면 **"검증되지 않음" 배지**. 테스트를 못 돌린 이유(의존성 없음 등)를 그대로 노출 | 계산류: **다른 방법으로 재유도**해 일치할 때만 "재확인됨". 불일치 시 양쪽 결과 병기. 서술류: "근거 인용됨 / 재확인 불가"를 구분 |
| **실패 시** | 로컬 재시도 → 모델 승격 → 국소 재계획 (설계서 3단계 복구 유지) | 되묻기 1회 → 범위 축소("이 절만") → 자료 부족 고지. **추측으로 메우지 않는다** |
| **사용자에게 숨기는 것** | 모델 라우팅·티어 결정·토큰 회계 | 동일. 단 **어느 자료의 어느 페이지를 근거로 썼는지는 절대 숨기지 않는다** |

### 4.3 값비싼 기능의 축소 이식 (gpai 3중 교차검증 → 우리 것)

gpai식 "항상 3개 모델 동시 호출"은 원가·지연이 3배다(§3.2, `[UGC]` 지연 불만이 이를 뒷받침). 우리 이식안:

1. **1차 호출 1회**로 답을 만든다.
2. **불일치 트리거가 있을 때만** 2차 호출: (코딩) 테스트 실패·린트 신규 경고·패치 적용 후 재현 실패, (학습) 계산 결과가 기호/수치 재유도와 불일치, 인용문이 원문과 문자열 불일치.
3. 2차 결과가 다르면 **하나를 고르지 않고 둘 다** 보여주고 "확인 필요" 배지.
→ T7(불일치를 신호로) + T8(원문 개방)의 결합이며, **"검증 통과한 답만" 같은 반증 불가능한 문구를 쓰지 않기 위한** 구조적 장치다.

### 4.4 한국 공학 사용자 특수 요구 (zero-config 판정 기준)

- **첫 화면이 질문을 요구하지 않는다.** gpai의 "오늘의 브리핑" 패턴(T10)을 로컬 상태에서 재현: *"지난 세션에서 `test_parser.py` 2건 실패 / 자료실에 3주차 강의 PDF 있음"*. 서버 연동 없이 동작해야 zero-config가 성립한다.
- **분류 실패를 사용자에게 전가하지 않는다.** 코딩/학습 판정이 애매하면 **첫 응답에 두 갈래 결과를 미리 보여준다**(예: "이 에러는 코드 문제입니다 — 고칠까요, 원인 설명부터 할까요?"). 선택지는 2개, 설정 화면은 없다.
- **한국어 혼용 요청 처리.** "이 코드 왜 터지는지 설명해줘" = 코딩+학습 동시 요청. 이때 **모드는 하나만 고르되 두 계약을 순차 적용**(먼저 학습 모드로 원인 3줄 → 사용자가 "고쳐줘"라고 하면 코딩 모드로 전환하고 패치). gpai가 표면을 배타적으로 나눈 것과 다른 점이며, 우리 도메인에서는 **필요한 개선**이다.
- **자료 형식:** HWPX/PDF 강의자료, 손글씨 풀이 사진, 수식 렌더링. gpai도 손글씨 스타일 출력·HWPX 편집을 지원하지만 우리는 **입력 측 손글씨 인식**이 더 중요하다(사용자 필기 과제).
- **네트워크·GPU 편차:** 강의실 노트북에서 RAM 8GB 미만이 흔하다 → 학습 모드의 긴 문맥 처리는 클라우드 위임, 코딩 모드의 반복 패치는 로컬 Tier로 처리하는 **모드별 티어 기본값 분기**가 필요하다. (gpai에는 없는 요구)

### 4.5 우리 제품에서 **하지 않기로** 하는 것 (gpai 관찰에서 도출한 금지 목록)

1. **"검증 통과한 답만" 류의 절대 보증 문구 금지.** 우리 약관/UI가 스스로 반증하지 않도록, 검증 범위를 항상 조건부로 표기(`테스트 3건 통과 / 미검증 2건`).
2. **"20×", "significantly more" 같은 상대 단위 과금 표기 금지.** 호출 수·토큰·예상 지연을 수치로.
3. **모델명을 마케팅 전면에 세우지 않기.** gpai는 모델 피커를 노출하지만, 우리는 zero-config이므로 모델은 라우팅 내부 사실로 두고 **"이번만 바꾸기"** 만 노출.
4. **LMS 자격증명 수집 금지.** 자료는 파일/폴더 단위.
5. **모드 수를 늘리지 않기.** gpai는 3표면 + 4도구로 늘렸으나, 우리는 **2표면(코딩/학습) + 깊이 다이얼**로 고정한다. 표면이 늘면 zero-config의 판정 부담이 사용자에게 되돌아온다.

### 4.6 미해결 설계 질문 (실행 증거로 답해야 하는 것)

| 질문 | 왜 지금 답할 수 없는가 | 어떻게 답할 것인가 |
|---|---|---|
| 자동 분류 정확도가 충분한가 | 공개 자료에 gpai의 분류 정확도 없음 `[미확인]` | 한국어 요청 100건 라벨링 → 오분류율 측정, 오분류 시 2지선다 폴백 발동률 기록 |
| 코딩 모드의 로컬 Tier 처리율 | 로컬 GGUF 성능은 우리 하드웨어 프로파일 의존 | Tier별 태스크 성공률 실측(설계서 Verification Engine 로그 사용) |
| 학습 모드에서 "이해"를 어떻게 측정하는가 | 자동 측정 불가 | 자가 점검 문항 정답률 + 동일 개념 재질문률을 대체 지표로 삼고, **"학습 효과 있음"이라고 주장하지 않는다** |
| 교차검증 축소(불일치 시에만 2차)가 오류를 실제로 잡는가 | gpai도 이 수치를 공개하지 않음 `[미확인]` | 실패 케이스 50건에 대해 1차 단독 vs 불일치 트리거 2차의 검출률 비교 |

---

## 5. 출처 (모든 접근일 2026-11-04)

**후보 A — GPAI (Turing Inc.) 공식**
| # | URL | 사용한 내용 |
|---|---|---|
| 1 | https://gpai.app/ko/product | 표면별 기능·활용 예시, AI Drive, 문제 생성, 슬라이드, 시각화, 교차검증 언급 |
| 2 | https://gpai.app/ko/landing | "오늘의 브리핑", 강의 포털 연동, 공동 편집 |
| 3 | https://gpai.app/landing | "cross-checks every output with TOP AI Engines", "200,000+ learners" |
| 4 | https://gpai.app/s/en/releases | **핵심 근거.** 2026-06-23 3표면 재편/단일 스위처, 2026-07-14 Visuals 등급(None/Standard/Premium), 2026-06-04 코드 실행, 2026-05-17 도구 자동 선택·애매 시 Clarify 폼, 2026-10-29 Figure Generator 스타일 Auto, 2026-09-07 아웃라인 선확정, 2026-09-02 AI Drive 참조 첨부 |
| 5 | https://gpai.app/terms | §3 서비스 목록, §10 면책("AI-generated content may contain errors … Never rely solely on GPAI"), 요금 구조 |
| 6 | https://gpai.app/usage-limits | Free 대비 3×/20×/40× 상대 한도 표기 |
| 7 | https://gpai.app/s/content/best-ai-stem-problem-solver-in-2026-step-by-step-solutions-cross-verification-and-hallucination-minimization | "proprietary CoT", "GPT, Claude, Gemini" 교차검증, 자사 비교표 |
| 8 | https://gpai.app/s/content/ai-for-teachers-in-2026-claude-for-teachers-gpai-and-what-each-one-is-built-for | **3모드 정의(Visuals/Problems/Chat)**, TikZ·RDKit 엔진, 모드별 역할 구분 |
| 9 | https://gpai.app/s/content/gpais-twin-problem-generator-ai-that-rewrites-the-problem-and-redraws-the-figure | `R₁ ≅ R₀` 동형 보존 주장, 변형 전략 선택, side-by-side 비교 |
| 10 | https://gpai.app/s/blog | 블로그 목록(위 글들의 색인) |
| 11 | https://gpai.app/s/library | 82,114개 아이콘, 카테고리 구성 |
| 12 | https://play.google.com/store/apps/details?id=com.gpai.app&hl=ko , https://play.google.com/store/apps/details?id=com.gpai.app&hl=en_US | 스토어 등록 문구(3기능·풀이 스타일·SVG), 다운로드 100만+, 리뷰(지연·날짜 오류) `[UGC]` |
| 13 | https://apps.apple.com/kr/app/gpai-%ED%95%99%EC%A0%90-%EC%83%81%EC%8A%B9-ai/id6748109514 | 한국어 등록 문구, "검증을 통과한 답만", 단계별·서술형·손글씨 스타일 |

**후보 A — 제3자**
| # | URL | 사용한 내용 |
|---|---|---|
| 14 | https://www.teamturing.com/ko/ | 회사 개요, GPAI 출시 2025-08, JEE Advanced 351/360, 150만·415개 대학 `[1차/회사 주장]` |
| 15 | https://platum.kr/archives/269581 | "STEM 특화 프리셋과 자동화된 워크플로우", "사용자별 학습 패턴에 맞춘 UX", 2025-08-28 `[2차]` |
| 16 | https://www.yna.co.kr/view/AKR20260402036900017 | "추론 최적화 기술과 시각화 엔진으로 환각 극복", 매출 830% `[2차, 회사 발표 인용]` |
| 17 | https://doinghun.com/startup-analysis-team-turing-gpai-college-ai/ | 3중 교차검증 비판, 수치 분모 문제, 리스크 목록 `[2차, 개인 분석글]` |
| 18 | https://bizcru.sh/ko/news/article/20260922-3843 | 2026-09-22 기능 3종 추가, "공개형 인터랙션" `[2차, 자동요약 기사]` |
| 19 | https://www.aitimes.com/news/articleView.html?idxno=215580 | "공개형 인터랙션" 정의, 기존 범용 AI와의 차별점 `[2차]` |
| 20 | https://www.venturesquare.net/1115869/ | 아웃라인 선확인, 유형·난이도 선선택, 국내 25개+ 대학 포털 `[2차]` |
| 21 | https://www.aitimes.com/news/articleView.html?idxno=202870 | 2025-09-30 미국 출시, 10월 한·일 진출 `[2차]` |

**후보 B/C — 이름 충돌 확인용**
| # | URL | 사용한 내용 |
|---|---|---|
| 22 | https://www.oecd.org/en/about/programmes/global-partnership-on-artificial-intelligence.html | GPAI = OECD 통합 파트너십(정책) |
| 23 | https://oecd.ai/en/about/about-gpai | 회원국 46개국 + EU |
| 24 | https://en.wikipedia.org/wiki/Global_Partnership_on_Artificial_Intelligence | 2020-06-15 출범, OECD 호스팅 |
| 25 | https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai | GPAI = General-Purpose AI 규제 용어 |

> **재현성 메모:** `gpai.app`의 `/agent`, `/solver`, `/chat`, `/visualizer`, `/drive`, `/problem-generator`, `/slide`, `/pricing`은 2026-11-04 비로그인 접근 시 전부 `login_required`로 응답했다. 내부 UI 관찰이 필요하면 계정이 있는 사람이 별도로 확인해야 하며, 그 전까지 §2의 "내부 동작" 서술은 **문서 기반 재구성**임을 유지한다.
