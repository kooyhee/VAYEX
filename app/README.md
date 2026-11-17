# VAYEX (바엑스) — 로컬 통합 AI 코딩 하네스

팀 자체 설계 한국어 UI와 **Node HTTP/WebSocket → Bun/omp stdio** 브리지입니다. 프런트엔드는 빌드·CDN·외부 npm 의존성이 없습니다. Node 26 이상이 브리지를 실행하고, 설치된 omp 18.16.0은 **Bun**이 실행합니다. 실제 코어와 모델 추론은 구분합니다.

**한 프로세스가 전부입니다.** 이 앱은 UI·브리지뿐 아니라 OpenAI 호환 추론 표면까지 같은 루프백 리스너에서 서비스합니다. `app/lib/inference.mjs`가 `gateway/lib/`의 모듈(`config.mjs`, `gateway.mjs`, `chat.mjs`, `selection.mjs`, `policy.mjs`, `identity.mjs`, `errors.mjs`)을 **복사하지 않고 그대로 import**하고, `server.mjs`가 `/v1/chat/completions`·`/v1/models`·`/v1/selection`·`/healthz`를 그 핸들러에 위임합니다(`app/server.mjs:220`). 앱은 자기 포트를 가리키는 `models.yml`을 직접 생성해 에이전트 런타임을 자기 자신에게 붙입니다. 로컬 하네스 + 별도 서버 게이트웨이로 나뉘던 이전 2평면 구조는 폐기되었습니다. `gateway/server.mjs`와 `start.sh`는 앱이 실행하지 않는 **선택적 독립 리스너**로만 남아 있습니다. 레거시 분리 엔드포인트 헬퍼는 모의/무추론 구성에서만 도달 가능한 잔존 경로입니다.

**서버 측 로컬 LLM 계획 폐기(server-side local LLM plan abandoned):** 요청 경로에 Ubuntu GPU 호스트는 없으며, SSH 터널(폐기), 8000/8787/4318 포트 분리(폐기), 서버 모델 배포(27B/FLUX)(폐기), GPU 상주/중재(residency/arbitration)(폐기), 서버 VRAM 기준 티어 강등(tier demotion)(폐기)은 모두 완전히 철회되었습니다. 업스트림 프로바이더는 설정 가능하며 로컬 프로세스에서 직접 도달합니다.

UI는 별도의 '코드'/'작업' 분리 탭 구조 대신 작업 실행, 실시간 대화, 변경 파일 검토(코드 리뷰)가 단일 화면에서 유기적으로 연동되는 **단일 작업 공간(Workspace)** 인터페이스를 제공하며, 세션 간 전환 시에도 작성 중인 입력창 초안(composer draft)이 세션별로 보존됩니다.

## 실행

```powershell
Set-Location '<repo>\app'
$env:OMP_CONFIG_FILE = 'C:\path\to\student-omp.json'
npm start
```

`http://127.0.0.1:4317`을 엽니다. 별도 지정이 없으면 앱 기준의 아래 경로를 사용합니다.

- `../.omp-runtime/node_modules/bun/bin/bun.exe`
- `../.omp-runtime/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`

런처로도 같은 브리지를 시작합니다. `launch.cmd`(더블클릭) 또는 `launch.ps1`이며, 인자 없이 `npm start`와 같은 경로를 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\launch.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\launch.ps1 -ConfigFile .\student-omp.json -Port 4317
```

`launch.ps1`은 시작 전에 Node 버전(`engines.node >= 26`), 실제 런타임 존재(`OMP_BINARY` 또는 `OMP_BUN`+`OMP_CLI`), `-ConfigFile`의 존재·JSON 여부를 확인하고, 없으면 해당 경로를 지목해 중단합니다. 아무것도 내려받거나 설치하지 않으며 다른 런타임으로 대체하지 않습니다. `-Mock`은 모의 코어를 명시적으로 선택할 때만 사용합니다. `-ConfigFile`은 UTF-8로 읽으므로 한국어 라벨이 있는 설정도 Windows PowerShell 5.1에서 그대로 통과합니다. 브리지도 세션마다 같은 런타임 검사를 반복하므로, 확인 후 런타임이 사라지면 `bridge_ready` 대신 `launch_failed`로 실패합니다. 모의 코어(`--mock`, `npm run mock`)만 런타임 검사를 건너뜁니다.

호출은 `bun.exe <cli.js> --mode rpc [coreArgs...]`입니다. **Node로 omp cli.js를 실행하면 `bun:` import 때문에 실패합니다.** Windows `.cmd` shim이나 shell을 사용하지 않습니다. 질문은 stdin JSON으로만 전달됩니다.

추론 설정이 없는 실행은 **코어를 띄우지 않습니다.** 설정에 `inference` 블록이 없거나 그 엔드포인트가 준비되지 않았으면, 그리고 `coreArgs`가 `--profile`/`--provider`/`--model`/`--models`를 재정의하려 하면 실행 전에 `launch_failed`로 끝납니다(`app/server.mjs:364-386`). 번들 설정을 읽지 못하거나 overlay를 읽지 못한 경우도 같은 방식으로 멈춥니다(fail-closed). 예전처럼 8787 호스트의 게이트웨이(폐기)로 조용히 되돌아가는 경로는 없습니다.

| 변수 | 의미 |
| --- | --- |
| `OMP_BUN` | Bun 실행 파일 경로. 기본은 위 프로젝트 로컬 경로 |
| `OMP_CLI` | Bun으로 실행할 omp cli.js 경로. 기본은 위 프로젝트 로컬 경로 |
| `OMP_BINARY` | 선택적 독립 omp 실행 파일. 지정 시 Bun/CLI 경로 대신 직접 실행. **node.exe를 지정하지 마세요.** |
| `OMP_CONFIG_FILE` | 앱 소유 실행·라우팅 JSON. omp 네이티브 설정 파일이 아님 |
| `PORT` | 루프백 HTTP 포트, 기본 `4317`. 추론 표면도 같은 포트 |
| `PI_CONFIG_DIR` | 실제 omp 변수. 18.16.0에서는 home과 join되므로 격리 시험에서 `.omp` 사용 |
| `PI_CODING_AGENT_DIR` | 실제 omp 에이전트 설정/상태 디렉터리. **이 앱은 자식에게 자기 소유 디렉터리(`<stateDir>/agent`)를 이 변수로 넘깁니다** |
| `OMP_PROFILE` | 실제 omp 명명된 프로필 선택. **앱은 자식 환경에서 이 값을 비웁니다** |

환경은 자식에 상속됩니다. 앱 JSON `coreEnv`는 자식에게만 전달할 값을 지정합니다. 시험은 고유 sandbox home 안에 `.omp/agent/`를 만들고 `HOME`, `USERPROFILE`, `PI_CONFIG_DIR=.omp`, `PI_CODING_AGENT_DIR=<sandbox>/.omp/agent`를 사용합니다. `OMP_HOME`은 사용하지 않습니다. 브리지 서버는 `OMP_CONFIG_FILE`이 지정되지 않으면 번들된 기본 설정 파일을 사용하며, `coreArgs`의 `--config` 경로는 `coreCwd`에 무관하게 안전하도록 `appRoot`를 기준으로 해석합니다. 번들 기본 설정의 적재는 fail-closed입니다: 읽거나 해석할 수 없으면 기본값으로 폴백하지 않고 설정 파일 경로와 오류를 지목해 `exit 1`로 중단합니다(`OMP_CONFIG_FILE`이 비어 있으면 "미설정"으로 보고 번들 `config.json`을 읽습니다).

### 앱 소유 `models.yml` (provider 등록은 omp에 맡기지 않습니다)

OMP 18.16.0은 `--config` 오버레이로 provider를 정의할 수 없습니다(직접 프로브: exit 1, `No default model selected`). 그래서 앱은 **자기 소유의 에이전트 디렉터리**를 `PI_CODING_AGENT_DIR`로 넘기고, 그 안의 `models.yml`을 실행 시마다 직접 씁니다.

- provider는 `harness-local` 하나, 모델 id는 `auto` 하나입니다. `baseUrl`은 **앱 자신의 루프백 `/v1`** 이고, 그래서 이 파일이 가리키는 호스트는 이 프로세스 밖에 있지 않습니다.
- 파일은 `0o600`으로 쓰고, 부모 디렉터리를 먼저 만듭니다(`app/lib/inference.mjs:80-90`).
- 사용자의 전역 `~/.omp/agent/models.yml`은 건드리지 않습니다.
- 상속된 `OMP_PROFILE`·`PI_PROFILE`·`PI_CONFIG_FILES`는 자식 환경에서 비웁니다. 다른 프로필이 이 실행의 provider 선택을 덮어쓰지 못하게 하기 위해서입니다.
- 생성된 파일의 `headers`에는 경로·신원·세션 토큰이 환경변수 이름으로만 적히고, 값은 자식 환경에서 읽힙니다. 그래서 경로가 다른 두 세션이 같은 파일을 다시 쓰지 않습니다.

시험에 사용한 구조(`x-route` 항목은 그대로 유지되는 계약입니다):

```yaml
providers:
  harness-local:
    baseUrl: http://127.0.0.1:<앱 포트>/v1
    api: openai-completions
    auth: none
    headers:
      x-route: OMP_BRIDGE_ROUTE
      x-user-id: OMP_BRIDGE_IDENTITY
      x-app-session: OMP_BRIDGE_SESSION
    models:
      - id: auto
        contextWindow: 32768
        maxTokens: 4096
```

이 이름의 외부 서버나 모델을 자동 설치·실행하지 않습니다. 실제 모델은 `inference.upstreams`가 가리키는 OpenAI 호환 업스트림이 제공하며, 번들 기본값은 **루프백의 데모 스텁**입니다. 스텁은 요청 경로·정책·선택 보고를 검증할 뿐 실제 추론을 하지 않습니다. 업스트림 모델 목록 확인은 추론 성공을 보장하지 않습니다. **`local_only` 경로는 루프백 `server_local` 업스트림만 받습니다.** 클라우드 업스트림은 `local_only`의 대체가 될 수 없습니다. 클라우드 경로는 그 대화의 명시 동의가 있어야만 서비스되고, 동의가 없으면 `403 consent_required`입니다. 요청에 실린 동의 헤더만으로는 통과하지 않습니다. `cloud`를 설정해도 조용한 자동 폴백은 하지 않습니다.

앱 설정의 추론 블록 예 (`config.json` 참고):

```json
{
  "coreArgs": ["--config", "omp-overlay.yml"],
  "coreEnv": {},
  "identity": "local-user",
  "local": { "label": "로컬 하네스 자동 선택 · 테스트 스텁 (추론 아님)", "provider": "harness-local", "model": "auto" },
  "background": { "label": "하네스 자동 선택", "provider": "harness-local", "model": "auto" },
  "cloud": null,
  "inference": {
    "route": { "default": "zdr_cloud" },
    "quota": { "identity_header": "x-user-id", "requests_per_day": 200, "tokens_per_day": 200000, "ledger_path": "./data/quota-ledger.json" },
    "logging": { "level": "info", "file": null, "log_request_bodies": false },
    "upstreams": [{
      "id": "demo-stub", "class": "server_local", "kind": "openai",
      "base_url": "http://127.0.0.1:8799/local/v1", "auth_mode": "none",
      "models": [{ "id": "demo-chat", "capabilities": ["chat"], "zero_data_retention": true, "training_opt_out": true, "context_window": 32768, "thinking_limit": 8192 }]
    }]
  }
}
```

`inference` 블록은 게이트웨이 라이브러리가 읽는 설정과 같은 모양입니다(`gateway/lib/config.mjs`). `logging.log_request_bodies`가 `true`면 앱은 시작 단계에서 거부합니다. 프롬프트 본문은 로그에 남기지 않는 것이 이 프로세스의 시작 조건입니다. 자격증명 리댁터는 게이트웨이의 기본 리댁터이며, 세션 토큰과 전달받은 `Authorization` 값도 여기에 등록되어 업스트림 메아리나 오류 본문으로 새지 않습니다.
omp의 네이티브 overlay는 실제 지원하는 `--config <config.yml>`를 `coreArgs`에 넣어 전달할 수 있습니다 (`omp-overlay.yml` 연계: 컨텍스트 압축 임계치 `thresholdPercent: 85`, 최근 토큰 보존 `keepRecentTokens: 20000`, 대형 출력 아티팩트 스필 임계치 `artifactSpillThreshold: 20KiB`, `artifactHeadBytes: 8KiB`, `artifactTailBytes: 8KiB`, `artifactTailLines: 200`, 약 4KiB 오버헤드 마진 구조적 지원; 네이티브 제네릭 비스트리밍 복구 가능 미리보기에 적용되나, 도구 바운드 및 아티팩트 복구 동작 자체는 네이티브 컨슈머 실행으로 검증된 것이 아닙니다. 24,576바이트는 헤드+테일 예산 차이에 따른 산술적 계산값일 뿐 실제 토큰·비용 절감이나 대형 출력 픽스처 실측 검증 결과가 아닙니다. 스트리밍은 네이티브 한도와 16MiB 아티팩트 상한을 유지하며, 85% 자동 트리거는 이미 15% 리저브를 두는 네이티브 기본값을 명시한 설정일 뿐 추가 토큰 절감량이 아닙니다. 반복된 행위 검증 실패로 인해 네이티브 최적화 검증은 부분적(partial) 상태로 종결되었습니다). 이 overlay는 **provider를 정의하지 않습니다** — provider 등록은 위의 앱 소유 `models.yml`이 맡습니다. 실시간 구동(`launch.ps1 -ConfigFile config.json -Port 4317`) 시 `/` 및 `/api/config` HTTP 200, WebSocket `bridge_ready` 핸드셰이크는 정상 확인되었습니다(실제 LLM 추론은 별개). Claude Code(프리픽스 정제), Codex(출력 한도 경계), OpenCode(컴팩션 리저브), Aider(컨텍스트 선택) 등의 설계 아이디어를 참조했으나 전량을 그대로 복제한 것은 아닙니다. 실험적 바운디드 도구 결과 확장은 **철회 상태로 유지**됩니다: `config.json`은 `--config omp-overlay.yml`만 전달하고 `--extension` 항목을 넣지 않으며, 이를 시험이 고정합니다. 정정된 측정에서 네이티브 아티팩트는 두 변형 모두 원본을 보존했고, 확장이 추가한 것은 350–521바이트의 고지 텍스트뿐입니다.

### 경로 헤더 `x-route` 계약

브리지가 모델 엔드포인트로 보내는 경로 헤더는 **`x-route`** 하나이고, 값은 게이트웨이와 같은 세 가지뿐입니다: **`local_only` | `zdr_cloud` | `any_cloud`**. 그 밖의 값은 만들지 않고 다른 평면으로 번역하지도 않습니다.

- 값은 **`/api/config` 요청의 `?route=`** 에서 결정합니다. 동의는 같은 요청의 **`?consent=1` 또는 `?consent=true`** 로만 인정합니다. 그 밖의 표기는 동의가 아닙니다(`?consent=yes`는 미동의).
- 알 수 없는 `route`는 **`local_only`로 fail-closed** 하고 응답 `route.invalid`에 원래 값을 남깁니다. 추측해서 보내지 않습니다.
- 클라우드 값(`zdr_cloud`/`any_cloud`)은 **`consent === true`가 아니면 소켓을 열기 전에 거절**합니다. 거절은 `available:false`와 이유로 보고되고, 요청 자체가 나가지 않습니다.
- 동의는 **요청 단위**입니다. 저장하지 않고 다음 요청·다음 대화로 상속하지 않습니다. 매 요청 `?consent=1`을 새로 붙여야 합니다.
- 같은 계약이 WebSocket 연결에도 적용됩니다. 한 연결이 한 대화이므로 그 연결의 경로·동의로 세션을 만들고, **동의 없는 클라우드 경로는 세션 생성 시점에 `bridge_error code:"consent_required"`로 끝나며 코어 프로세스를 실행하지 않습니다.** 알 수 없는 경로는 `code:"invalid_route"`입니다.
- **쿼리만 받습니다.** `/api/config`의 인정 형식은 `?route=<세 값 중 하나>`와 `?consent=1|true`(둘 다 선택, 생략 시 `local_only`/미동의로 fail-closed)이고, `/ws`는 여기에 재접속용 `?session=<기존 세션 id>`를 더합니다. 경로·동의를 담는 헤더나 쿠키 대체 경로는 **없습니다**: 브리지는 쿠키를 읽지도 쓰지도 않으며, 읽는 헤더는 `Host`/`Origin`/`Sec-WebSocket-*`뿐입니다. 브리지 서버 자체는 쿼리 생략 시 `local_only`/미동의로 fail-closed 처리되지만, UI는 새 브라우저 세션 시작 시 `route=zdr_cloud&consent=1`을 `/api/config`와 WebSocket 요청 양쪽에 각각 붙여 전달하므로 별도 동의 대화상자 없이 프롬프트를 수락합니다.
- 추론 요청에도 같은 값이 실립니다. 브리지는 자식 환경에 **`OMP_BRIDGE_ROUTE`** 로 그 대화의 경로를 넣고, `models.yml`의 provider `headers`에 `x-route: OMP_BRIDGE_ROUTE`를 적으면 omp가 요청마다 환경에서 값을 읽습니다. 이 방식은 이 기기의 실제 omp 18.16.0 + Bun에서 확인했습니다. 세션마다 자기 환경을 받으므로 **공유 `models.yml`을 다시 쓰지 않으며** 경로가 다른 두 세션이 파일에서 경합하지 않습니다.
- **주의(실측)와 방어:** 그 환경 변수가 설정되지 않은 상태에서는 omp가 헤더를 생략하지 않고 **변수 이름 문자열 `OMP_BRIDGE_ROUTE`를 값으로 그대로 보냅니다.** 그래서 브리지는 실행 전에 `models.yml`/`models.json`의 `x-route` 항목을 읽어 omp와 같은 방식으로 값을 해석하고, 결과가 그 대화의 경로와 다르면 **코어를 실행하지 않고 `launch_failed`로 끝냅니다**(`routeHeaderProblem`). 변수 이름을 잘못 적었거나, 값이 비었거나, 리터럴 경로가 대화와 다르면 모두 여기서 막힙니다. 이 검사는 자식이 실제로 읽는 `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`/`OMP_PROFILE` 기준 경로를 사용하며, 항목이 아예 없으면(=헤더 미전송) 통과합니다. 게이트웨이의 `400 invalid_route`는 이와 별개의 두 번째 방어선이며, 브리지는 그것에 의존하지 않습니다.
- 헤더가 실리는 곳: **자식 omp의 추론 요청**입니다. 앱이 생성한 `models.yml`에는 `x-route: OMP_BRIDGE_ROUTE`가 항상 들어 있으므로 모든 추론 요청에 경로가 실립니다. (`inference`가 없는 모의·레거시 구성에서만 이 헤더가 없습니다.)
- **동의는 이 프로세스가 직접 확인합니다.** `/v1/` 요청의 `x-route`가 클라우드 값이면 그 요청의 `x-app-session` 토큰이 가리키는 세션이 같은 경로·신원이고 `consent === true`여야 합니다. 세션이 없거나 동의가 없으면 **`403 consent_required`**, 토큰이 세션과 어긋나면 `403 session_route_mismatch`입니다. 요청에 실린 동의 헤더만으로는 통과하지 않습니다. 이 검사는 `app/lib/inference.mjs`의 `authorize`에 있습니다.
- **`local_only`는 루프백 `server_local` 업스트림만 받습니다.** 앱 안에서는 `local_only`가 서비스되는 경로이고, 허용 목록에 없는 클라우드 업스트림을 로컬 평면으로 대체하지 않습니다(그 경우 `400 local_only_not_served`). 독립 실행되는 `gateway/server.mjs`는 예전과 같이 `local_only`를 거절하며, 그 리스너는 앱이 실행하지 않습니다.

### 모델 라벨 계약 (`GET /v1/selection` 되읽기)

모델과 추론 강도는 이 프로세스 안의 게이트웨이 로직이 자동으로 고릅니다. 스트리밍 응답은 제공자 바이트를 그대로 중계하므로 그 결정은 응답 헤더에만 남고, 페이지는 나중에 읽을 것이 없습니다. 그래서 브리지가 마지막 결정을 되읽어 그 세션에만 알립니다.

- **읽기:** 턴이 끝난 프레임을 받으면 브리지가 **같은 프로세스의 선택 기록**을 그 대화의 신원+경로로 읽습니다(`inference.selection(s)`). 별도 HTTP 왕복이 없습니다. 대화의 신원을 확정할 수 없으면 읽지 않습니다. 기록은 `gateway/lib/`의 선택 모듈이 남기며, `GET /v1/selection`도 같은 기록을 돌려줍니다.
- **경계:** 기록은 신원+경로당 마지막 결정 1건, 메모리 전용, 용량 16, 재시작 시 초기화입니다. 프롬프트 텍스트·키·헤더는 저장하지 않으며 `Cache-Control: no-store`로 서비스됩니다. `GET /v1/selection`은 결정 이전에는 `{"selection":null}`, 신원 헤더 누락 시 `401 identity_required`, 알 수 없는 경로 시 `400 invalid_route`를 반환합니다. 반환 값은 리댁터를 한 번 더 거칩니다.
- **전달:** 성공한 결과만 그 세션에 `selection` 프레임으로 브로드캐스트합니다. 세션마다 자기 신원과 경로로 읽으므로 다른 세션의 선택이 새지 않습니다.
- **표시:** 선택이 없으면 라벨은 정확히 **`자동`** 이고, 그것은 "자동으로 고른다"만 주장합니다. 선택이 오면 라벨이 **구체적 모델 id** 로 바뀌고, 실제로 보고된 필드만으로 `추론 <등급> · 생각 토큰 <budget>`를 덧붙입니다(등급이 없으면 등급을, budget이 없으면 그 항목을 쓰지 않습니다). 새로 만든 세션에 아직 아무 입력이 없으면 결정도 없으므로 **`자동`만** 보입니다. 비용·절감 수치는 어디에서도 만들지 않습니다.
- **단위:** 기록의 한도는 **신원+경로당**이지 메시지 단위가 아닙니다. 같은 신원과 경로를 쓰는 두 세션은 같은 모델을 표시할 수 있습니다.
- **오류 UI 없음:** 선택이 없거나 `selection:null`이면 오류 상자·연결 상태 변화·전송 차단을 만들지 않습니다. 페이지는 스스로 선택을 요청하지 않습니다.
- **레거시 경계:** `readSelection()`(루프백 `{endpoint}/selection` 조회, 타임아웃 1.5초, 재시도 없음, 실패는 `null`)은 **`inference`가 없는 모의·무추론 구성에서만** 도달하는 잔존 경로입니다. 제품 경로에서는 쓰이지 않습니다.

### `app/orchestrator/` — 독립 DAG 스케줄러 (실 턴 경로 아님)

`app/orchestrator/orchestrator.mjs`는 의존성·파일 충돌·예산을 스스로 판정하는 **독립 실행용 DAG 스케줄러**입니다. 브리지는 이 모듈을 import하지 않으며(유일한 import는 `app/test/orchestrator.test.mjs:3`), 실 턴 경로에서 실행되지 않습니다. 그래서 라이브 최적화 계층이 아니라 **대안/독립 스케줄러**입니다.

실 턴이 단일 모델·단일 프레임인 것은 의도입니다: 브리지는 한 프레임을 한 코어 자식에 쓰고(`app/server.mjs:852`), 역할 체인 하나를 순차 해석하며(`app/server.mjs:856-865`), 추론 표면은 요청당 핸들러 하나를 디스패치합니다(`app/lib/inference.mjs:255`). 서브에이전트 스케줄링은 코어가 소유합니다 — omp `TaskTool`의 `WorkPool`이 `task.batch`(기본 true)와 `task.maxConcurrency`(기본 32)로 돌리고, 그 상태는 허용 명령 `get_subagents`로 UI에 드러납니다(`app/public/protocol.js:193`). 이 모듈은 그 자리를 대체하는 이음매가 아니라 같은 일을 하는 두 번째 경로입니다.

직접 구동할 때의 계약(그리고 실제 측정값):

- **병렬 이득 하한 `MIN_PARALLEL_GAIN = 1.15`.** 준비된 작업 묶음의 `seqMs/parMs`가 이 값 이상일 때만 병렬로 돌리고, 큐가 두 개 이상이라는 이유만으로 동시 실행하지 않습니다.
- **파일 충돌 잠금은 묶음 선택 시점에 획득합니다.** 커밋 뒤가 아닙니다. 한 파일을 이름 붙인 두 작업이 같은 묶음에 들어가지 않으므로 동시 보유가 불가능합니다.
- **실패 시 에스컬레이션 체인** `tier-1-fast → tier-2-medium → tier-3-smart`(`DEFAULT_ESCALATION`), 마지막 시도까지 실패하면 **부분 재계획(partial replan)**: 실패 작업만 드롭되고 그 종속 작업은 `blocked`가 되며 독립 작업은 계속 돕니다. 전체 중단은 남은 실행 가능 작업이 없을 때만 일어납니다.
- **종속 차단은 전이적입니다.** 2차 종속 작업을 `pending`으로 남기면 `ready()`를 영원히 통과하지 못하므로 함께 `blocked`로 표시합니다.
- 진행 요약은 로컬이며(`localProgressSummary`), 요약 모델을 호출하지 않습니다.

`node --test test/orchestrator.test.mjs`는 **6/6 통과**이며, 위 두 결함(커밋 전 잠금, 전이적 차단)을 각각 고정하는 시험을 포함합니다. 이 시험들은 스케줄러 자체의 동작만 검증하며 실 턴 경로가 이 모듈을 사용한다는 증거가 아닙니다.

## DX 계층 (`app/dx/**`) 실행 경로

`/api/dx/*`는 브리지(`app/server.mjs`)가 같은 프로세스에서 서비스합니다. 문서에 적힌 동작이 실제로 도는 경로는 다음과 같습니다.

- **수정 전 파일 보존은 브리지가 직접 합니다.** 코어가 도구를 실행하기 전에 보내는 `tool_execution_start` 프레임을 브리지가 라우터의 `noteFrame(sessionId, frame)`에 넘기고, 쓰기 도구(`write`/`edit`/`str_replace`/`apply_patch` 등)이고 경로 인자(`path`, `file_path`, `files[]`, `edits[].path`)가 있을 때만 그 파일의 현재 내용을 스냅샷으로 남깁니다. 읽기·명령 실행은 스냅샷을 만들지 않습니다. 세션 id가 작업 키이므로 diff 패널이 읽는 키와 같습니다. 상대 경로는 코어의 작업 디렉터리(`coreCwd`, 기본 `app/`)를 기준으로 해석하고, 그 트리 밖 경로는 건드리지 않습니다.
- **`POST /api/dx/snapshot/diff`와 `GET /api/dx/snapshot/diff`는 같은 결과를 돌려줍니다.** `taskId`는 쿼리 문자열 또는 JSON 본문에서 읽고, 둘 다 없으면 400입니다. 수동으로 파일을 고치는 클라이언트를 위해 `POST /api/dx/snapshot/record`(`{taskId, filePath}`)도 그대로 있습니다.
- **스냅샷은 재시작을 넘깁니다.** `SnapshotManager.init()`이 `snapshots/<taskId>/manifest.json`과 내용 파일을 읽어 메모리 색인을 다시 만듭니다. 내용 파일이 사라진 항목은 "빈 원본"으로 되돌리지 않도록 색인에서 제외합니다.
- **비용 개요는 실제 턴을 셉니다.** 라우터는 `gateway/lib/events.mjs`의 프로세스 버스에서 `llm_turn` 기록을 읽어(`eventsFrom`) `GET /api/dx/cost/overview`·`/cost/task` 응답 직전에 아직 세지 않은 기록만 반영합니다(`seq`+`ts`+`taskId`로 중복 제거). 금액은 게이트웨이가 계산한 실측 비용(`cost.usd`, 토큰 × 해당 모델 게시 단가)을 쓰고, 사용량을 보고하지 않은 턴은 0이 아니라 **집계에서 제외**합니다.
- **캐시 적중률**은 `캐시로 읽은 토큰 ÷ (캐시로 읽은 토큰 + 캐시 없이 보낸 프롬프트 토큰)`으로 모델별·전체를 모두 계산합니다(`cache.byModel`, `cache.hitRate`). 제공자가 캐시 수치를 아예 보고하지 않으면 `null`/`미집계`이고 0%로 채우지 않습니다. 제공자가 0을 보고한 경우는 실측 0%입니다.
- **메모리 훅은 라우터가 등록합니다.** `createDxRouter`는 `resolveMemoryLayer`가 주어지면 `TaskResumeManager.setMemoryHook`에 `app/memory/resume.mjs`의 `memoryResumeState`를 연결하므로, `POST /api/dx/tasks/resume`의 `memoryState`가 실제 메모리 계층에서 채워집니다.

## 첫 화면과 승인

브라우저 세션마다 별도 자식을 실행합니다. `ready.protocolVersion=1`은 실패가 아닙니다. 지원 목록에 2가 있는지 확인하고 id가 있는 `negotiate_protocol`의 성공 응답 `data.protocolVersion=2`를 받은 뒤 준비 상태가 됩니다. 시작 시 위젯 알림도 전달하며 명령 목록 업데이트 프레임을 수신·해석합니다.

기본 모델이 없으면 stdout 없이 종료할 수 있습니다. UI는 종료 코드와 최근 최대 16 KiB stderr를 표시합니다. `No default model selected...`가 빈 화면 대신 보입니다. 진단에 로컬 경로 등이 포함될 수 있으므로 공개할 때 확인하세요.

도구 승인은 관찰된 `method:"select"`의 **options 전체를 순서대로 버튼으로 만듭니다**. 알려진 항목은 한국어 라벨로 바꿔 표시하고, 모르는 항목은 원문 그대로 표시합니다.

- `Approve` → 한 번 승인
- `Approve bash for this session` → 이 세션에서 bash 승인
- `Deny` → 거절

코어가 내는 **핵심 option에는 각각 자기 한국어 라벨**이 있습니다(`public/protocol.js` `approvalLabel`): `Approve`/`Approve Once` → `한 번 승인`, `Approve File` → `파일에 대해 승인`, `Always Approve File` → `항상 파일에 대해 승인`, `Always Approve` → `항상 승인`, `Approve Directory: <path>` → `폴더에 대해 승인: <path>`, `Always Approve Directory: <path>` → `항상 폴더에 대해 승인: <path>`, `Approve <subject> for this session` → `이 세션에서 <subject> 승인`, `Deny` → `거절`. 이전에는 `write` 도구의 승인 버튼만 `Approve Once`라는 영어 원문으로 남아 있었고, 지금은 전역 승인과 세션 승인이 서로 다른 라벨로 구분됩니다. 클릭 시 되돌려 보내는 값은 **코어의 원문 라벨**입니다.

응답은 `{type:"extension_ui_response",id:<요청 id>,value:<선택한 원문 라벨>}`입니다. value가 실제 options에 있는지 검사합니다. 승인 모드 select 요소는 제공되지 않으며, select 응답에는 `confirmed`를 보내지 않습니다(`confirmed`는 `method:"confirm"` 요청에만 `true|false`로 붙습니다). 브라우저 자체 항상 승인 캐시도 없습니다. 세션 승인 정책은 코어가 관리합니다. 알 수 없는 option도 원문 그대로 표시합니다. 설치 패키지 타입에 있는 confirm/input/editor도 지원하지만 이번 실제 승인 왕복 검증 대상은 select입니다.

`setWidget`은 승인이 아닙니다. `widgetLines`는 UI 모델의 위젯 항목에 저장하고, 없으면 그 항목을 지웁니다. 두 경우 모두 화면에 그리지 않습니다(`app.js`/`index.html`/`styles.css`에 위젯 렌더러가 없습니다). 초기 `autoresearch` 위젯 해제는 승인 카드를 만들지 않습니다. `isError` 도구 카드는 자동으로 펼쳐 코어가 보고한 결과 텍스트를 보여 줍니다. 실패 전용 문구나 fail-closed 표기는 UI에 없습니다.

## 렌더링 및 무시 범위

wire 해석과 v2 재조립은 JSDoc 타입의 `public/protocol.js`에 격리됩니다. 명시적 UI 모델에는 메시지/블록, 도구, 승인, 단계, 위젯, 오류 기록, 코어 모델, prompt 종료 상태가 있습니다.

| 프레임 | 화면/처리 |
| --- | --- |
| `ready`, `response(negotiate_protocol)` | 브리지 협상/크기 한도. 대화에는 원문을 표시하지 않음 |
| `rpc_chunk` | 협상 후 순서·base64·크기를 검증해 논리 프레임으로 재조립. 청크 자체는 비표시 |
| `response` 실패 | parse/unknown-command를 포함해 오류와 기록으로 표시. 루프/연결은 유지 |
| `response(get_state)` 성공 | model, thinkingLevel, todoPhases, contextUsage, dumpTools, sessionId와 streaming/compacting 상태를 반영 |
| `agent_start`, `turn_start`, `turn_end`, `agent_end`, `session_settled` | 이벤트에 따른 단계 |
| `message_start/update/end` | user/assistant 대화. id 없는 메시지도 턴별 분리, 사용자 echo 중복 방지 |
| `text_start/delta/end` | contentIndex별 텍스트/partial snapshot. snapshot과 delta를 중복 더하지 않음 |
| `toolcall_start/delta/end` | 준비 단계 및 partial에 실제 있는 이름·인자만 표시 |
| `tool_execution_start/update/end` | 이름, 인자, 부분/최종 결과, isError에 따른 실패 |
| extension UI select/confirm/input/editor | 승인/입력 카드 및 응답 |
| extension UI setWidget/cancel/notify | 위젯 갱신·삭제(UI 모델만, 화면 표시 없음) / 대화상자 취소 / 알림 기록(UI 모델만, 화면 표시 없음) |
| `available_commands_update` | 프레임을 수신해 명령 목록 데이터를 파싱하나, 카탈로그 팝업 UI로는 렌더링하지 않음 |
| `prompt_result` | completed/aborted/error, sessionSettled 및 오류 message |
| `selection` | 이 세션에 대해 브리지가 같은 프로세스의 선택 기록에서 읽은 마지막 자동 선택. 세션별로만 반영하며 다른 세션으로 넘기지 않음 |
| `subagent_*` | 실제 수신 이벤트/상태를 백그라운드 표시로 반영 |
| `extension_error`, `rpc_frame_error` | 오류 기록 |

명시적으로 렌더링하지 않는 것:

- 성공한 다른 명령의 response.data: 단순 ACK를 대화 메시지로 만들지 않습니다.
- get_state 필드 중 UI 모델로 복사하지 않는 것: systemPrompt/messageCount/queuedMessages/goal. 시스템 프롬프트를 화면에 노출하지 않습니다. dumpTools/sessionId/contextUsage/todoPhases는 복사하며 위 표대로 처리합니다(todoPhases는 완료 단계 공개 버튼으로 표시).
- 도구 details.wallTimeMs는 읽지 않습니다. 토큰·비용은 `get_session_stats`가 보고한 값(없으면 메시지 usage로 누적한 값)을 헤더(`#head-meta`)에 `토큰`과 `$cost`로 표시하고, 프롬프트 경과 시간이 있으면 초 단위로 덧붙입니다. 코어가 토큰 사용량을 보고하지 않은 세션에서 헤더는 `토큰 미보고`입니다. 속도는 표시하지 않습니다. 가공의 지표는 물론 예시 픽스처나 "예시" 출처 뱃지도 모두 제거되어 브리지/코어가 실제로 보고한 데이터만 표시합니다.
- 비텍스트 블록(이미지/thinking 등), user/assistant 외 역할: 직접 버블로 표시하지 않습니다. 도구 결과는 tool_execution 프레임에서 표시합니다.
- 지원하지 않는 extension 메서드는 자동 승인·실행하지 않고 `vm.notices`에 미지원 기록을 남기며, 이 기록은 화면에 렌더링하지 않습니다. setStatus/setTitle/set_editor_text/open_url/ask 전용 상호작용은 미구현입니다.
- 위 표에 없는 frame type은 relay하되 UI는 무시합니다. 예: live/dictation/btw, command_output, session_info_update, config_update.

NDJSON 상한은 **1,048,576 bytes (개행 포함)**, v2 논리 프레임 상한은 **67,108,864 bytes**입니다. get_state가 작다고 가정하지 않습니다. 브라우저에는 재조립한 논리 JSON을 전달합니다. 브라우저→코어 명령은 물리 상한을 넘으면 거절합니다(입력 청크 생성 미구현). stdin/stdout drain backpressure, bounded queue, Host/Origin 검사, 루프백 바인딩을 유지합니다. 마지막 브라우저가 나가면 자식이 종료됩니다. 정상 SIGINT/SIGTERM은 자식 종료를 기다립니다. 인증된 원격 서버나 파일 샌드박스는 아닙니다.

### 연결 끊김과 입력 대기열

- **고친 결함**: 코어 stdin이 가득 차면 서버가 클라이언트 소켓을 일시 정지했고, 그 정지가 프레임 리더까지 멈춰 클라이언트 연결 끊김을 관찰하지 못했습니다. 그래서 세션과 자식이 shutdown까지 살아 남았습니다.
- **현재 동작**: 클라이언트 읽기를 더 이상 멈추지 않습니다. backpressure는 자식 stdin 대기열을 세션당 약 5 MiB(세션 8개)로 묶고, close·reset·half-close를 모두 관찰하며 정리는 정확히 한 번 실행됩니다(`app/server.mjs`, `app/websocket.mjs`).
- **그 결과 생기는 동작 두 가지**: ① 대기열 한도를 넘는 폭주 입력은 클라이언트를 늦추는 대신 세션을 `backpressure`로 실패시킵니다. ② TCP 신호 없이 사라진 peer는 여전히 감지되지 않습니다.

## 프라이버시 가드와 개인정보 보호 줄

전송 전 가명화는 `app/privacy/`의 게이트가 하고, 브리지는 그 결과만 화면에 넘깁니다.

- **한 요청 = 한 프레임**: 나가는 요청마다 게이트가 남긴 가명/차단 기록 중 **그 요청의 상관 토큰과 일치하는 것 하나**만 `privacy.masked`/`privacy.blocked` 프레임으로 릴레이합니다(`app/server.mjs` `relayPrivacy`). 프레임이 싣는 필드는 `rules`, `counts`, `fields`, `fingerprint`, `code`뿐이고 원문 값은 프레임·이벤트 기록·로그·DOM 어디에도 없습니다. 같은 세션의 다른 요청이나 대역외 `/api/privacy/scan`이 남긴 기록은 이 요청의 줄로 쓰이지 않습니다.
- **탐지와 게시의 분리**: 탐지기에는 **원본 키를 문맥 힌트로** 넘기고, 외부로 나가는 쪽(프레임 필드 경로)은 정리된 경로만 씁니다. 이 분리가 없으면 한국어 문맥 키(`비밀번호`, `주민번호` 등)의 가명 처리가 함께 사라집니다.
- **남은 한계는 공개되어 있습니다**: `app/privacy/detectors.mjs`의 `DOCUMENTED RESIDUALS` 주석이 이 빌드에서 실제로 통과되는 형태를 열거하고, `test/pii-mask.test.mjs`의 `every documented residual is still exactly as documented`가 그 목록을 그대로 단언합니다. 즉 아래 형태들은 **여전히 탐지되지 않습니다**: 공백이 있는 따옴표 없는 암호구, 기능어가 섞인 따옴표 문장, 한 글자 브래킷 값 등. 목록을 줄이려면 탐지기를 고치고 시험을 함께 고쳐야 합니다.

## 보고서·차트 접근성 (독립 수용 완료)

Modern Web Guidance(`https://github.com/GoogleChrome/modern-web-guidance-src`)의 `accessibility`(§6 복잡한 이미지와 차트), `container-queries`, `print` 기준으로 다음이 **구현 및 독립 수용(accepted) 완료**된 상태입니다.

- **차트 값과 의존 관계의 텍스트 노출 (`public/visualize.js`)**: `renderTaskGraph`·`renderCostChart`·`renderMemoryChart`는 모두 `role="group"`에 `<title>`(이름)과 `<desc>`(의미)를 달고 `aria-labelledby`/`aria-describedby`로 연결합니다. 각 행은 `role="list"` 안의 `role="listitem"`이고 `aria-label` 한 문장에 보고된 값을 그대로 담습니다(예: `빌드 · 1,200 토큰 · 비용 미보고`, `검토자 · 메인 작업에 의존 · 완료 · 레인 1`). 그림은 `aria-hidden`이므로 라벨만 읽히지 않고 값과 관계가 읽힙니다. 화면(`app.js`)의 통계 탭과 내보낸 문서가 같은 함수를 씁니다. 비용·모델 식별자는 대체 텍스트에 **전체 문자열**로 실리며 잘라 쓰지 않습니다.
- **없는 값은 없는 채로**: 서버가 이름만 알리고 건수를 보고하지 않은 메모리 유형은 `0건`이 아니라 **미집계**, 보고되지 않은 토큰·비용·레인·모델은 **미보고**입니다. 작업 상태는 알 수 없거나 누락되면 **미보고**, 실제 `waiting`/`idle`일 때만 **대기**입니다(`stateWord`). 메모리 현황 합계가 보고되지 않으면 그대로 미보고로 남고, 서버가 보고한 0은 0으로 표시되며, 도넛은 **모든 구성 값이 보고된 경우에만** 그립니다(`memoryChartData`가 `null`을 보존).
- **대비**: 테마 삭제 라벨·건수·배지의 실제 live 계산 대비가 기준(≥4.5:1)을 충족합니다(다크 8.76/8.76/8.99, 라이트 5.74/5.74/5.11; 실측 회귀 시험 포함 독립 수용 완료).
- **내보낸 다이어그램의 텍스트 대체물 (`public/session-report.js`)**: 단계 흐름도·실행 구조도는 `<figure aria-labelledby>` + `<svg role="img" aria-describedby>`이고, `.diagram-alt`(`#flow-alt`, `#arch-alt`)가 항상 함께 내보내집니다. 흐름은 보고된 모든 단계를 일지 순서 `<ol>`로(그림은 12개에서 자름), 구조도는 계층 연결 순서와 역할 분담을 `<ol>`/`<ul>`로 나열합니다.
- **rem 조판 + 34rem 이하 대응**: 문서 CSS는 여백·글자 크기·간격을 rem으로 정의하고 섹션마다 `container-type: inline-size`를 둡니다. 34rem 이하에서는 축소된 SVG를 숨기고 `.diagram-alt`만 남기며, `table.data`를 `thead` 없는 카드형 행으로 쌓고 `td::before{content:attr(data-label)}`로 열 이름을 유지합니다.
- **자기완결 내보내기 + A4 인쇄 유지**: 외부 CDN·폰트·이미지 의존성 없이 스타일·스크립트가 파일에 인라인됩니다. `@page{size:A4;margin:14mm}`와 인쇄 규칙(섹션별 `break-before: page`, 표·그림·푸터 `break-inside: avoid`, 인쇄 시 그림 복원)은 그대로 유지됩니다. **독립 리뷰어 시각 점검**: 대표 현재 PDF를 육안 확인한 결과 A4 4페이지 모두 잘림·겹침 없이 사용 가능하며, 좁은 레이아웃에서도 가로 넘침이 없음을 확인했습니다(후속 수정분에서도 인쇄 레이아웃 변경 없음).
- **초점 시험 (독립 수용)**: `node --test test/visualize.test.mjs test/memory-chart-truth.test.mjs test/report-accessibility.test.mjs` **17/17 통과**(실패·취소·생략 0) 및 갱신된 `test/report-accessibility.test.mjs` **10/10 통과**(17/17과 중복 범위이므로 합산하지 않음)로 4건 결함 수정과 회귀 시험이 모두 독립 수용되었습니다.

## 반응형 셸 및 접근성 상호작용 (드로어 3건·전환 입력 결함 독립 수용 완료 · 실제 200% 줌 미검증)

Modern Web Guidance 기준으로 아래 셸·레이아웃 기능이 구현되었으며, 전환 입력 결함은 해소·독립 수용되었고 실제 `200%` 줌만 미검증인 상태입니다(보고서·차트 접근성 독립 수용과는 별도 범위).

- **독립 수용된 범위 및 미검증**: `1180px` 이상 데스크톱 좌측 사이드바 `260px`·우측 인스펙터 `364px` 정확 비율과 브레이크포인트 이하(`320px` 및 `640 CSS px` 등가 확인) 좁은 화면의 **가로 넘침 없음**은 독립 수용되었습니다. 실제 브라우저 `200%` 줌은 **미검증**입니다. 격리된 Edge에서 두 번 시도했으나 모두 **도구 사유로 실패**했습니다(175%까지 도달한 뒤 최종 줌 입력이 `user_input_active`로 끝났고, 이후 격리 Edge는 조기 종료). 따라서 `320px`/`640 CSS px` 등가가 **유일한 레이아웃 근거**이며 `200%`에서의 사용성은 주장하지 않습니다.
- **드로어 결함 3건 수정(독립 수용 완료 — 구현·시험 검토 및 통과치 재사용)**: 이전 독립 셸 리뷰의 3건(① `Shift+Tab` 시 드로어에서 스킵 링크로 이탈, ② 드로어 닫힘 후 `fullscreen` 인스펙터 잔류, ③ 사이드바 검색·메모리 목적지 숨김/`inert`)은 독립 셸 리뷰어가 저장된 구현과 회귀 시험을 검토하고 기존 작성자 통과치(`test/frontend-native-keyboard.test.mjs` **6/6** + 기타 프론트엔드 **17/17** = **23/23**, 전환 수정 후 **7/7** + **17/17** = **24/24**; 브라우저 **63/63**, 서버 정합 **5/5**)를 재사용하여 **독립 수용 완료**했습니다(신규 재실행이나 실시간 라이브 드로어 재현은 수행하지 않음).
- **좁은 폭 세션 헤더**: 헤더의 메타 줄은 조각 하나가 한 요소(`.head-meta-part`)이고 조각 사이에서만 줄바꿈합니다. 이전에는 `140px` 상한이 줄 전체를 잘라 `사유: a…`로 끝났고, 지금은 `사유: auto`가 통째로 남습니다(좁은 폭 규칙은 `white-space: normal`, `text-overflow: clip`). 옆의 제어 요소는 자기 크기를 유지합니다(`public/styles.css`).
- **전환 입력 결함 수정(독립 수용 완료 — 신규 리뷰어가 구현·시험 타당성 수용)**: 원인은 스코프된 **ViewTransition 기반 전환**이 전환 중 인스펙터의 히트 테스트를 잃는 것이었고, 그 의미론을 폐기하고 **`Element.animate` 180ms 불투명도·6px 이동의 장식용 수신 패널 전환**으로 대체했습니다. 상태·ARIA·포커스 동기화는 즉시 반영되고 `prefers-reduced-motion` 및 API 부재 시 폴백은 유지됩니다. 회귀 시험은 **실제 앱 애니메이션을 20초로 늘린 상태에서** 실제 터치 스터디와 마우스 스펙이 **동작 중 통과**함을 확인합니다. 신규 리뷰어가 구현과 시험 타당성을 **독립 수용**했고 통과치는 저장된 실행을 재사용했습니다(재실행 없음): 프론트엔드 Node **24/24**(`test/frontend-native-keyboard.test.mjs` **7/7** + 기타 **17/17**), 브라우저 회귀 **63/63**, 서버 정합 **5/5**. 이로써 프론트엔드의 알려진 입력 결함은 해소되었으나 제품 전체 검증이 완료된 것은 아닙니다(실제 `200%` 줌은 별도로 열려 있음). 힌트 팝오버(`aria-describedby`)와 인스펙터 컨테이너 쿼리(`<=340px` / `>=470px`) 구현은 그대로 유지됩니다.

## 실제 수행한 검증

환경: Node **26.13.0**, 프로젝트 로컬 Bun **1.4.4**, 실제 omp **18.16.0**.

`npm test`(`node --test test/*.test.mjs`)의 현재 전체 lane 수치는 루트 `README.md`의 '테스트 및 검증 메트릭'에 있습니다. 그 lane에서 부하에 민감하게 실패하던 시험 3건을 진단해 고쳤고, 그중 (1)은 실제 제품 결함이었습니다.

1. **세션 목록 포커스 소실(제품 결함)** → 브리지 프레임마다 세션 목록을 다시 만들어 키보드 포커스가 사라지고 활성화 키가 `<body>`에 떨어짐 → 행마다 세션 키를 달고 재구성 뒤 포커스를 복원하며, 포커스된 세션이 사라지면 목록의 머리 버튼으로 돌립니다(`public/app.js`).
2. **실코어 시험 스텁의 UTF-8 손상** → HTTP 청크를 하나씩 디코드해 청크 경계에 걸친 한국어·이모지 코드 포인트가 깨짐 → 청크를 이어 붙인 뒤 한 번만 UTF-8 디코드합니다(`test/real-fixture.mjs`).
3. **프라이버시 지연 측정의 부하 오염** → 병렬 시험 자식에게 CPU를 빼앗긴 시간까지 스캔 비용으로 계산함 → 항목당 비용을 연속 5회 스캔 중 가장 빠른 값으로 하고, p50(0.5 ms)과 p95(5 ms) 예산을 모두 단언합니다.

이전 인증 실행에서 핑거프린트한 앱·게이트웨이 산출물 **176개는 전부 불변**, 추가 0건, 실행 전후 Node/Bun/Chrome 프로세스 수는 **0 대 0**이었습니다. 이전 실행의 **160개 중 153 통과·6 실패·1 취소**는 **과거 기록**입니다. 초점 통과치는 그대로 유효합니다: 브리지 통합 **29/29**(2회 실행 모두), 게이트웨이 suite **36/36**, 게이트웨이 회계 **12/12**, 프라이버시 findings **16/16**. 독립 리뷰는 **출력 접미사 계약**, **준비 수명주기**, 그리고 **peer teardown**을 모두 **수용**했습니다(재리뷰에서 새로운 경합 없음). 이전 실행의 **156/156**(실패 0, 생략 0)은 과거 기록이며 현재 상태를 대신하지 않습니다. 보고서·차트 초점 suite는 `node --test test/visualize.test.mjs test/memory-chart-truth.test.mjs test/report-accessibility.test.mjs` **17/17** 및 갱신된 `test/report-accessibility.test.mjs` **10/10**(중복 범위, 합산 금지; 실패·취소·생략 0)로 모두 독립 수용되었습니다. 앱 suite에는 실제 Bun/omp 18.16.0 실행 시험이 포함되며(그중 일부는 실행 전 거부를 확인하는 시험), 모델 응답만 로컬 OpenAI 호환 HTTP 스텁입니다. **실제 모델 추론이나 클라우드 호출을 수행한 것은 아닙니다.**

고친 결함은 다음과 같습니다(증상 → 원인 → 수정).

- **OMP 준비 판정(증상: 준비 대기가 `protocol_mismatch`로 라벨링)** → 원인: startup 탐색 구간을 협상 타이머가 판정 → 수정: 준비 단계에 별도 **60초 상한 `startup_timeout`**을 두고, ready 이전 중단은 `startup_cancelled`로 끝내며, `ready` 이후에만 별도 **15초 `negotiation_timeout`**이 시작됩니다. 모든 종료 경로가 자식을 종료하고 종료를 기다린 뒤 admission을 반납하고 peer를 닫습니다. 준비 수명주기는 독립 리뷰에서 **수용**되었습니다.
- **출력 계약(증상: 바이트 단언 2건 실패)** → 원인: 1초 이상 실행에서 OMP가 붙이는 네이티브 `Wall time` 접미사를 stdout 단언이 전제하지 않음 → 수정: 실제 출력을 **손실 없이** 보존하도록 기대를 정정하고 경계·복구 회귀를 결정적으로 추가했습니다. 독립 리뷰 **수용**.
- **세션 정리(증상: peer teardown 미완료) — 독립 수용 완료** → 원인: `Peer.close()`가 닫힘 핸드셰이크에 응답하지 않는 peer에서 전송을 **CLOSING에 영구 고착**시켜 `close`가 발생하지 않음 → 수정: 정리 시 peer 전송을 **능동 파괴**하고, 종료 shutdown 중 admission을 **동기적으로 반납**해 exit 대기자가 여전히 admitted 상태로 보지 않도록 했으며(소켓 close 전달을 보류하는 child-exit-boundary 회귀로 입증), `stopChild`를 SIGKILL 에스컬레이션을 유지한 **단일 실행(single-flight)**으로 만들고, peer 폴백 destroy 타이머를 추적해 소켓 close 시 취소함으로써 이중 destroy가 없도록 했습니다. 재리뷰에서 새로운 경합은 발견되지 않았습니다.
- **할당량 원장(증상: job 수락 후 500)** → 원인: 비디오 경로의 업스트림 후 `settle`이 다른 핸들이 `quota-ledger.json`을 쥔 상태의 Windows 원자적 교체에서 `EPERM`을 만나 `GatewayError`가 아닌 오류로 새어 500이 됨 → 수정: 일시적 교체 오류에 **약 140ms 한도 재시도**, 예산을 넘으면 오류를 그대로 올리고, 예상 밖 500은 리댁션된 원인을 기록하며, 원장 읽기 경로도 같은 주입 파일시스템 seam을 씁니다. `quota.ledger_path`는 로컬·비동기화 경로여야 합니다(`gateway/README.md`에 문서화). 독립 리뷰 **수용**.
- **CWD 가정(증상: CWD에 따라 깨지는 경로)** → 원인: 시험 3개가 프로세스 CWD로 `app/app/...` 경로를 구성 → 수정: 모듈 상대 경로로 바꾸고 app CWD와 프로젝트 루트 양쪽에서 확인했습니다.
- **비밀 카나리(증상: 43건 매치)** → 원인: 모두 자격 증명이 아닌 값(생성된 transcript/blob 해시, Edge 환경설정 무결성 MAC, 의도된 픽스처) → 수정: 스캔 범위를 값별 허용과 함께 정정하고, 픽스처 내부를 포함한 현실적 자격 증명 형태에 대한 양성 통제를 추가했습니다.
- **키보드 시험 7건 생략(증상: `Google Chrome not found`로 7건이 skip)** → 원인: 브라우저 탐색이 Chrome 설치 경로만 봐서, Edge만 있는 이 머신에서 실제 커버리지가 통째로 빠짐 → 수정: `CHROME_PATH`를 우선하고 Chrome·Edge·Chromium의 표준 설치 경로(Windows·macOS·Linux)를 차례로 찾아 **Chromium 계열이 하나라도 있으면 실행**하며, 정말 없을 때만 사유에 빠진 능력을 지목해 생략합니다(`test/frontend-native-keyboard.test.mjs`).
- **수명주기 시험이 부하에서 간헐 취소** → 원인: 실시간 대기가 이름 없는 개별 타임아웃을 써서 러너 타임아웃과 경합 → 수정: 모든 대기가 하나의 명시적 예산(`LIFECYCLE_BUDGET_MS`, 30초)을 공유하고 러너 타임아웃은 그 위(+5초)에 있어, 멈춤이 나면 멈춘 단계의 이름을 대고 실패합니다(`test/bridge.integration.test.mjs`).

프론트엔드·셸 검증 수치(신규 리뷰어가 구현·시험 타당성을 독립 수용했고 저장된 통과치를 재사용, 재실행 없음; 전환 입력 결함은 해소, 실제 `200%` 줌만 미검증): 프론트엔드 Node 시험 **24/24**(`test/frontend-native-keyboard.test.mjs` **7/7** + 기타 프론트엔드 Node 시험 **17/17**, 생략 0; 이전 드로어 리뷰에서 재사용한 **23/23**은 그 시점 기록), 브라우저 회귀(`public/frontend-regression.test.html`) **63/63**, 브라우저 서버 정합(`public/frontend-server-truth.test.html`) **5/5**. 전환 결함은 스코프된 ViewTransition이 전환 중 인스펙터 히트 테스트를 잃던 것이었고, `Element.animate` 180ms 불투명도·6px 장식 전환으로 대체했으며 상태·ARIA·포커스 동기화는 즉시, reduced-motion·API 부재 폴백 유지, 회귀 시험은 실제 앱 애니메이션을 20초로 늘린 상태에서 실제 터치·마우스 입력이 동작 중 통과함을 확인합니다. IME 안전 Enter, 실패한 diff 정리, 인스펙터 roving tabindex, 문서 유형 라디오 그룹, Theme Studio 네이티브 모달, 디자인 모드 `Alt+Enter` 검사 및 반응형 셸·컨테이너 쿼리는 Modern Web Guidance(`https://github.com/GoogleChrome/modern-web-guidance-src`) 가이드 기준이며, `legacy-scan app/public`은 가이드 코퍼스의 약 **20%**만 결정적 규칙으로 덮으므로 지적 0건이 전체 접근성 보증이 아닙니다. 비밀 카나리는 런타임 데이터 저장소와 바이너리 문서를 스캔하지 않고, 할당량 원장 재시도는 외부 점유를 약 **140ms**까지만 흡수합니다.

2026-11-17 재실행 실측: 도메인 게이트웨이 라이브러리 스위트(프로젝트 루트에서 `node --test gateway/test/*.test.mjs`, `gateway/` 안에서는 같은 파일에 대해 `node --test test/`)는 **152/152**(통과 152, 실패 0, 취소 0, 생략 0, 약 12초)입니다. 이전 실행에서 통과한 값(이번에 다시 돌리지 않음, 부분 suite를 합산해 전체 통과로 취급하지 않음): 엔진 기준선(engine historical baseline)은 319개(재실행하지 않음)입니다.

통합 경로 실측(단일 프로세스): `/healthz`가 `mode: local-harness`와 `compatible_endpoint: http://127.0.0.1:4317/v1`을 보고하고, `/v1/models`가 루프백 데모 스텁 모델을 돌려주며, `/v1/selection`은 턴 이전에 `{"selection":null}`, 턴 이후에 실제 기록을 돌려주었습니다. UI 라벨은 `자동` → `demo-chat` + `추론 높음 · 생각 토큰 8192` → 새 세션에서 다시 `자동`으로 움직였고, 실행 중 8787 포트에는 어떤 프로세스도 리슨하지 않았습니다(nothing listened on 8787). 이 실측은 **스텁 업스트림** 대상이며 실제 추론이 아닙니다.

실제 코어로 확인한 상태:

1. v2 협상, get_state, id 없는 스트리밍 턴, prompt_result/session_settled.
2. 잘못된 JSON의 id 없는 parse 오류와 id가 반영된 unknown-command 오류. 이후 프롬프트 정상 완료로 루프 생존 확인.
3. 실제 bash 승인 select의 정확한 `Deny` 왕복과 tool_execution_end.isError=true.
4. 기본 모델 없는 startup의 **stderr `No default model selected...` 및 exit 1**.
5. `--no-ui`의 `Tool "bash" requires approval but no interactive UI available.`.
6. 승인 대기 중 stdin 종료의 `RPC client disconnected before extension UI response completed`.
7. 시작 시 setWidget(autoresearch)와 available_commands_update 수신 처리(51개 명령 파싱). 사용자 제공 캡처의 약 48개를 고정값으로 강제하지 않습니다.
8. 추론 요청의 `x-route`: 실제 omp가 앱이 생성한 `models.yml`의 provider `headers` 항목 `x-route: OMP_BRIDGE_ROUTE`를 요청마다 자식 환경에서 읽습니다. 경로가 다른 두 세션(`local_only`, `zdr_cloud`)을 실행해 각 요청이 자기 값을 보내는 것을 확인했고, 파일을 다시 쓰지 않았습니다. 동의 없는 `any_cloud` 연결은 `bridge_error code:"consent_required"`로 끝나고 스텁 요청도 코어 프로세스도 생기지 않았습니다. 위조한 동의 헤더는 무시되고 `/v1/` 추론 요청은 `403 consent_required`로 거절됩니다. 변수 자체가 비어 있으면 omp가 변수 이름을 값으로 보냅니다(직접 확인).
9. 내보내지 않은 변수 이름을 `x-route` 값으로 둔 실제 실행 구성은 브리지가 **코어를 실행하기 전에 `launch_failed`로 막습니다.** 실제 omp + 스텁으로 확인했고, 스텁에는 추론 요청이 0건, 자식 프로세스도 0개였습니다.
10. 선택 라벨: 같은 프로세스의 기록을 읽어 `selection` 프레임으로 그 세션에만 브로드캐스트하며, 결정 이전에는 `{"selection":null}`/`자동`이고, 턴 이후에는 구체 모델 id와 등급·budget이 표시되는 것을 통합 경로에서 확인했습니다. 새 세션은 다시 `자동`입니다. 이 기록은 신원+경로 단위이지 메시지 단위가 아닙니다.
11. 할당량 예약/정산: 알 수 없는 사용량을 0으로 꾸며내지 않고, 리댁션은 대체보다 기본 리댁터가 이깁니다. 프롬프트 본문 로깅은 시작 단계에서 거부됩니다(`log_request_bodies: true` → 기동 거부).

bash-only 프로브의 실제 get_state는 UTF-8 **12,831 bytes**였습니다. 제공된 캡처의 **31,370 bytes**와 달라도 오류가 아니며 구성에 따른 차이입니다. 시험은 크기 고정값 대신 상태 계약을 확인합니다.

Chromium에서 실제 브리지에 접속해 일반 대화 → 도구 승인 → Deny → 도구 실패, parse/unknown 오류 기록 → 후속 정상 대화, 모델 미선택 startup, headless fail-closed 결과를 직접 확인했습니다. 세 문서 모두 **console error 0건**. 1282×866 및 375×812에서 확인했고 좁은 화면 가로 넘침과 외부 origin 리소스가 없었습니다. stdin-disconnect는 실제 코어 자동 시험과 어댑터 결과로 확인했으며 별도 브라우저 제스처로 재현하지는 않았습니다.

단위/모의 검증 범위: 1 MiB 초과 UTF-8 v2 chunk 재조립·잘못된 순서·협상 전 거부, 물리 프레임 초과, 버전 불일치, 실행 파일 부재, 코어 crash, 세션별 자식/종료, 비승인 startup 알림, id 없는 다중 턴. 실제 64 MiB chunk 전송, 실제 세션 승인 재사용, 실제 bash 승인 실행, 실제 confirm/input/editor 왕복은 시험하지 않았습니다.

초기 실코어 시험은 Windows 절대 PI_CONFIG_DIR가 home에 중복 join되는 설정 오류로 실패했습니다. `.omp` 상대값으로 수정했습니다. 이후 HTTP 스텁의 배열형 user content를 정규화하고 구성별 get_state 크기를 고정한 잘못된 시험 기대를 제거한 뒤 최종 통과했습니다. 최초 실패를 실코어 성공으로 집계하지 않았습니다.

## 검증 재현 / 모의 모드

```powershell
npm test
# 실제 omp + 로컬 HTTP 모델 스텁 UI (추론 없음)
node test/real-fixture.mjs
# http://127.0.0.1:4320
```

fixture는 고유 sandbox home과 HTTP 스텁을 사용합니다. `hello`는 텍스트, `tool` 포함 질문은 무해한 `echo omp-approval-ok` 승인 요청을 만듭니다. 이번 검증에서는 Deny만 선택해 명령을 실행하지 않았습니다. `--no-model`, `--headless`, `PORT`도 지원합니다. 정상 종료 시 sandbox를 정리합니다. 스텁의 `/probe/errors`와 `/probe/disconnect`는 시험 전용이며 제품 브리지에는 없습니다.

실제 코어 없는 모의 UI는 `npm run mock`입니다. 일반 UI 페이지 자체는 가공의 예시 행을 합성하지 않고 브리지/코어의 실제 보고 내용만 렌더링하지만, `npm run mock`은 독립된 모의 서버 모드로 작동하며 명확한 모의 배너가 나타납니다. `/approval`·`/select`는 관찰된 options 형식, `/input`·`/editor`는 합성 요청, `/refuse`·`/crash`·`/large`는 오류, `/chunk`는 합성 큰 프레임입니다. `OMP_MOCK_SCENARIO=mismatch` 또는 `startup-failure`도 지원합니다. 시험 후 변수를 해제하세요. 검증 서버는 작업 종료 시 중지합니다.

## 라이선스

omp는 MIT입니다. 이 앱은 upstream 코드를 복사하거나 런타임을 재배포하지 않고 기존 설치를 실행합니다. omp/Bun 포함 배포물에는 각각의 **실제 원문 저작권·라이선스·제3자 고지**를 유지해야 합니다. 임의 고지로 대체하지 않습니다. 패키징과 upstream 고지 수집은 이 앱 작업 범위에서 검증하지 않았습니다.
