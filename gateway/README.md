# Gateway library (in-process inference core)

An OpenAI-compatible gateway: model allowlist, route policy, per-identity quota
ledger that survives a restart, key custody, and proxying to three classes of
upstream. It is plain Node with no dependencies and no build step.

**How it runs now.** The product path is a single local process.
`40_AI보고서/app/lib/inference.mjs` imports these modules — `lib/config.mjs`,
`lib/gateway.mjs`, `lib/chat.mjs`, `lib/selection.mjs`, `lib/policy.mjs`,
`lib/identity.mjs`, `lib/errors.mjs` — rather than copying them, and
`app/server.mjs` mounts the resulting handler on the app's own loopback listener
(`/v1/chat/completions`, `/v1/models`, `/v1/selection`, `/healthz`). There is no
separate gateway host in the request path: the app launches its agent against its
own endpoint and writes an app-owned `models.yml` whose `baseUrl` is that port.
The earlier two-plane split (local harness plus a separate server gateway reached
over a tunnel) is **폐기/abandoned**, and so is the plan to host a model on a
server of our own.

`server.mjs` and `start.sh` in this directory remain as an **optional standalone
listener that nothing in the app launches**. Sections 3–4 below describe that
listener and its historical deployment form; read them as the optional artifact,
not as the current design. The library behaviour in sections 2 and 5–12 is what
the app actually runs.

## 0. Status, stated plainly

- **Implemented and verified against a stub upstream.** Every endpoint and policy
  in this README was exercised by a real HTTP request against a running handler
  that talked to a local stub provider, and by author automated tests (**156/156**, 0 fail, 0 skip: measured on 2026-11-17 with `node --test gateway/test/*.test.mjs`; independently reviewed). The app's own suite (`node --test test/*.test.mjs`) covers the in-process path with **154/154**, 0 fail. The long-term memory layer passes **42/42**. Browser independent regression tests passed **51/51** (47 maintained baseline + 4 selection/workspace, independently reviewed PASS). The engine historical baseline is **319 pass** (historical, not re-run). Following containment of the failed prompt cache key integration (new cache module/test removed, active chat key injection/scrubber removed, base credential redaction and standard relay restored; log.mjs unused custom-scrubber hook remains passive rather than a byte-for-byte original restoration; non-null `prompt_cache_key` explicitly rejected with `400 unsupported_parameter`; `x-session-id` alone does not inject keys), cache key optimization is WITHDRAWN / NOT DELIVERED and unavailable. Withdrawal was independently verified, and containment review is PASS for safe gateway restart. Passive `supports_prompt_cache_key` parsing in config/catalog remains default `false`, but the feature is unavailable. Live refresh is handled separately. The exact request/response evidence for verified baseline policies is in section 13.
- **Not demonstrated live.** The competition demonstration is a pre-recorded
  video. Nothing here was shown running in front of anyone. It is a built, tested
  artifact, nothing more.
- **The bundled upstream is a demo stub on loopback.** The app's shipped
  `config.json` defines one upstream, `demo-stub` at `127.0.0.1:8799`, and no real
  model is behind it. A `server_local` upstream means "an on-device loopback
  OpenAI-compatible server, if one is configured", not "a GPU model is serving this
  today". The abandoned plan to deploy a server model (27B, FLUX, GPU residency,
  leasing) is 폐기 and is not part of this product.
- **Live-verified single-process facts:** In live integration testing of the in-process architecture, `/healthz` reported `mode: local-harness` and `compatible_endpoint: http://127.0.0.1:4317/v1`; `/v1/models` listed the loopback demo stub model; `/v1/selection` returned `{"selection":null}` before a turn and a real record after; the UI label transitioned `자동` → `demo-chat` with `추론 높음 · 생각 토큰 8192` → `자동` in a new session; nothing listened on port 8787 during that run.
- **Ollama and the cloud proxies were never contacted from here.** Their health
  probing, model listing and auth handling are verified against stubs that
  reproduce the documented response shapes. The Ollama model ids in the example
  config come from the deployment audit.
- **GPU state is reported as `unknown` wherever no supported source answered,**
  and never as zero and never as healthy. See section 11.
- **What does work end to end today:** policy enforcement (allowlist, routes,
  quota, custody, redaction) is real code against real inputs, and the proxy path
  works against any OpenAI-compatible server you point it at.

## 1. Runtime: Node, and why

**Node 22.23.1** (that build was used for the standalone verification runs; the
library also runs on Node 26.13.0, which is what the app uses on this machine).

The deployment target described next is the **폐기된 배포 계획** (abandoned
deployment plan), kept as the history of the optional standalone listener: an
Ubuntu 24.04 tower, user `sungjung`, **no sudo**, no docker or podman, no conda/uv,
no torch, a PEP-668 externally managed Python that would have needed a venv, and
zero `systemd --user` units. The gateway is I/O shaping, not compute: it reads
JSON, forwards bytes and pipes SSE, which is exactly what Node's streams do with
no library. So: Node, zero dependencies, `node:test` for tests. That reasoning
also explains why the app can import the library into its own process unchanged.

## 2. What it exposes

| Method | Path | Behaviour |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | Streams SSE when `stream: true`, otherwise returns JSON. Forwards only allowlisted fields. Relays upstream errors with the provider's own status and code. |
| `POST` | `/v1/images/generations` | Same allowlist, route policy and quota ledger as chat. Not streamed. |
| `POST` | `/v1/videos` | Submits an async job, answers `202` with a gateway job id. |
| `GET` | `/v1/videos/{id}` | Job state: `queued`, `running`, `succeeded`, `failed`, with progress when the upstream provides it. |
| `GET` | `/v1/videos/{id}/content` | The artifact bytes, fetched server-side so the upstream credential stays here. |
| `GET` | `/v1/models` | The gateway's allowlist itself, not what an upstream advertises. |
| `GET` | `/v1/selection` | The last automatic model + reasoning decision for the calling identity and route, read-only and in-memory. `{"selection":null}` before any decision. See section 7.2. |
| `GET` | `/healthz` | Real cached probe of every upstream. `503` when any upstream is unreachable. |

Identity is the `x-user-id` header (configurable). Route is `x-route` or a `route`
body field. A request that names both with different values is refused rather
than resolved.

## 3. Run it (optional standalone listener — 폐기된 배포 형태)

**Nothing in the app launches this.** The shipped product runs the library
in-process (§ top and § 2); these commands only exist for someone who wants the
standalone artifact on a machine of their own. The deployment host, the tmux
session and the tunnel ports below are the **폐기된 배포 계획**, preserved as the
record of what was tried, not as instructions for this product.

The exact commands, from a shell on a machine with this directory copied to
`~/gateway`:

```sh
cd ~/gateway
cp gateway.config.example.json gateway.config.json   # then edit: remove upstreams you have no key for
export OPENROUTER_API_KEY='...'                       # only for a gateway_key upstream
sh start.sh ./gateway.config.json
```

Expected first lines (the numbers change with your config and kernel; the shape
does not). One of the two `open-file limit:` forms appears, depending on whether
this Node build exposes `setrlimit`; on Ubuntu 24.04 it usually does not, so the
second form, read from `/proc/self/limits`, is the one you would see:

```
open-file limit (shell): soft=65535 hard=1048576
{"ts":"...","level":"info","event":"gateway_starting",...,"listen":"127.0.0.1:8000",...}
{"ts":"...","level":"info","event":"gateway_listening","url":"http://127.0.0.1:8000",...}
open-file limit: soft=65535 hard=1048576 (target 65535, raised in-process)      <- Node has setrlimit
open-file limit: soft=65535 hard=1048576 (target 65535, not raised in-process)  <- otherwise; the shell raise held
{"ts":"...","level":"info","event":"listen_address","host":"127.0.0.1","port":8000,"loopback_only":true,...}
```

Whichever form appears, the soft limit printed must be the raised one. If it is
still `1024`, the shell raise failed and the warning line above it says so; fix
that before running concurrent SSE clients.

`start.sh` raises the open-file limit with `ulimit -n` (a shell builtin, no
privileges needed), prints the limits it got, and execs `node server.mjs`. A
foreground process in a tmux session was the whole deployment form on that host:

```sh
tmux new -s gateway
cd ~/gateway && sh start.sh ./gateway.config.json
# detach: Ctrl-b d     reattach: tmux attach -t gateway
```

Server startup prints a JSON line declaring the mode: upstreams and their classes,
the allowlist size, which key environment variables are set (names and booleans,
never values), the quota limits, whether request-body logging is on, the listen
address, and the open-file limits.

To run the tests: `node --test test/` from this directory.

### 3.1 Environment variables

| variable | used for | required |
| --- | --- | --- |
| `GATEWAY_CONFIG` | config path when `--config` is not given | no |
| `GATEWAY_OPEN_FILES` | soft fd limit `start.sh` asks for (default `65535`) | no |
| `OPENROUTER_API_KEY` | the OpenRouter upstream's key, named by that upstream's `key_env` | only if that upstream is used |
| `BASETEN_API_KEY` | the Baseten upstream's key, named by that upstream's `key_env` | only if that upstream is used |
| `GATEWAY_UPSTREAM_KEY` | fallback key name, from `keys.upstream_key_env` | only if an upstream omits `key_env` |

Nothing else is read from the environment, and no key is ever written anywhere.
An upstream whose `key_env` is unset starts fine and refuses with `503`; startup
logs a warning naming the variable, not its value. An `auth_mode: "pass_through"`
upstream needs no environment variable at all, which is what makes BYOK work
without the gateway holding a secret.

### 3.2 The mode it is running in

Startup states it in the first log line and in the plain-text lines that follow:
the listen address, the default route, each upstream with its `class` and key
variable, the allowlist size, the quota limits and ledger path, and whether
request-body logging is on. `/healthz` reports the same `mode` block at runtime. If
you need to know whether this deployment is forwarding prompts to a third party,
read `pass_through_upstreams` and `auth_modes` there rather than guessing.

## 4. Binding (the tunnel is 폐기)

The default listen host is `127.0.0.1`. A non-loopback host is **refused** by the
config parser unless `listen.allow_non_loopback_bind` is explicitly `true`:

```
config error: listen.host: refusing to bind 0.0.0.0: only a loopback host is allowed
unless listen.allow_non_loopback_bind is set to true. This host is shared; bind
127.0.0.1 and reach it through an SSH tunnel
```

That guard is still real code and still worth keeping: a listener bound to a
routable interface on a shared machine is exposed to every tenant of it, and the
check happens before any socket is created, so a typo cannot cause the exposure.

**The SSH tunnel it mentions is 폐기.** There is no remote host, no forwarded
port and no tunnel in this product's request path; the app's own loopback
listener is the whole transport. The historical deployment used a forward tunnel
from a machine that could reach the router, with only port 2025 forwarded and
`GatewayPorts no`, so no gateway port was ever reachable directly:

```sh
ssh -N -L 8000:127.0.0.1:8000 -p 2025 sungjung@220.68.175.38
```

That command is a record of a plan that was abandoned, not a step of the current
design; do not reintroduce a remote inference host through a forwarded loopback
port, because a `127.0.0.1` connection through such a forward is not evidence of
on-device inference.

## 5. Config file shape

`gateway.config.example.json` is a complete, illustrative file. The fields:

```jsonc
{
  "listen": {
    "host": "127.0.0.1",              // non-loopback needs the opt-in below
    "port": 8000,                     // matches the tunnel in section 4
    "allow_non_loopback_bind": false,
    "open_files_target": 65535        // requested soft limit
  },
  "route": { "default": "zdr_cloud" }, // local_only is rejected as a default
  "keys": { "upstream_key_env": "GATEWAY_UPSTREAM_KEY" }, // fallback env name
  "quota": {
    "identity_header": "x-user-id",
    "requests_per_day": 200,
    "tokens_per_day": 200000,
    "ledger_path": "./data/quota-ledger.json"
  },
  "logging": {
    "level": "info",
    "log_request_bodies": false,       // true prints a warning at startup
    "file": "./data/gateway.log"       // null = stdout only
  },
  "health": { "cache_ms": 5000, "timeout_ms": 2500 },
  "timeouts": { "upstream_ms": 60000, "video_ms": 30000 },
  "max_body_bytes": 2097152,
  "upstreams": [ /* see below */ ]
}
```

An upstream record, with every field that matters (this one is an example of a
`server_local` Ollama record and a `proxy` record is shown in section 6):

```jsonc
{
  "id": "ollama",                      // stable identifier, appears in errors and health
  "class": "server_local",             // server_local | proxy | direct
  "kind": "ollama",                    // openai | ollama (ollama implies server_local)
  "base_url": "http://127.0.0.1:11434/v1",
  "auth_mode": "none",                 // gateway_key | pass_through | none
  "key_env": "OPENROUTER_API_KEY",     // only meaningful for gateway_key
  "paths": { "models": "/models", "chat": "/chat/completions",
             "images": "/images/generations",
             "ps": "/api/ps", "tags": "/api/tags" },  // ps/tags: ollama only
  "video": { "create_path": "/videos", "poll_path": "/videos/{id}",
             "content_path": "/videos/{id}/content" },  // required for video models
  "models": [
    {
      "id": "qwen3:32b",
      "display_name": "Qwen3 32B (Ollama)",
      "capabilities": ["chat"],        // chat | images | video
      "zero_data_retention": true,     // per model, not per upstream
      "training_opt_out": true,
      "context_window": 40960,
      "supports_prompt_cache_key": false // opt-in; gates prompt_cache_key forwarding
    }
  ]
}
```

Rules the parser enforces, all of which fail the config rather than degrade:

- `class` is `server_local`, `proxy` or `direct`. A `server_local` `base_url` must
  point at a loopback host; nothing else is "local".
- A model id resolves to **exactly one** upstream. The same id under two upstreams
  is an invalid config. There is no fallback chain.
- `zero_data_retention` and `training_opt_out` are declared per model, because one
  proxy carries models with different retention policies.
- `supports_prompt_cache_key` is NOT DELIVERED / WITHDRAWN following failed independent
  security review. Passive configuration and catalogue parsing remain default `false`, but the feature is unavailable. Do not attempt to configure or enable this field.

### 5.1 Prompt Cache Key Status: WITHDRAWN / NOT DELIVERED (Contained)

Prompt cache key optimization (`prompt_cache_key` / `supports_prompt_cache_key`) is **withdrawn and not delivered**:
- **Containment Completed:** The separate cache module and tests have been removed. Active chat completions contain no cache key injection or specialized scrubbers; original base credential redaction and standard relay/logger behavior are restored.
- **Rejection Contract:** Any non-null `prompt_cache_key` in request bodies or headers is explicitly rejected with `400 unsupported_parameter`. An `x-session-id` header alone does not inject any cache key.
- **No Enablement Advice:** Operators and users must NOT configure or enable `"supports_prompt_cache_key": true` (in gateway config: `"supports_prompt_cache_key": false`, distinct from OMP model compatibility `supportsPromptCacheKey`). Passive parsing defaults to `false` and the feature is unavailable; do not offer or follow enablement instructions.
- **Scope Boundary:** No live prompt cache optimization is supported, claimed, or recommended. Withdrawal has been independently verified, and containment review is PASS for safe gateway restart (live refresh is handled separately). Gateway automated tests are 156/156 (0 fail, 0 skip): the contained baseline suite plus the selection read-back and the runtime-enforcement tests, independently confirmed.

## 6. The three upstream classes, with real examples

`class` is not decoration. It says whether the prompt leaves the host.

| class | who runs it | what it is | auth |
| --- | --- | --- | --- |
| `server_local` | us | a model on this machine, served OpenAI-compatible | usually none |
| `proxy` | a third party relaying others | OpenRouter, A6API | per-provider key or BYOK |
| `direct` | the origin provider | the provider's own endpoint | per-provider key |

### 6.1 Ollama as `server_local`

The server runs Ollama 0.21.0 at `127.0.0.1:11434` with 36 models and 321 GB of
weights. Ollama exposes an OpenAI-compatible surface at `/v1`, so it is a
`server_local` upstream with `kind: "ollama"`:

```jsonc
{
  "id": "ollama",
  "class": "server_local",
  "kind": "ollama",
  "base_url": "http://127.0.0.1:11434/v1",
  "auth_mode": "none",
  "paths": {
    "models": "/models",            // health uses /api/tags, not this
    "chat": "/chat/completions",
    "images": "/images/generations",
    "ps": "/api/ps",                // residency
    "tags": "/api/tags"             // installed models
  },
  "models": [
    { "id": "qwen2.5:72b", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true, "context_window": 32768 },
    { "id": "qwen3:32b", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true, "context_window": 40960 },
    { "id": "qwen2.5:32b", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true, "context_window": 32768 },
    { "id": "qwen3-embedding:0.6b", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true }
  ]
}
```

`/healthz` probes an Ollama upstream through **its own API**: `GET /api/tags` for
reachability and the installed model list, then `GET /api/ps` for residency. It
never assumes Ollama is up because the port is open, and it never assumes a model
is loaded because the file exists on disk.

`qwen3-embedding:0.6b` is an embedding model. It is listed above with
`capabilities: ["chat"]` only because this gateway serves chat; if you route to it
as a chat model it will answer with an upstream error, which is the honest
outcome. Embeddings are not part of this gateway's surface.

A model id must equal the id Ollama reports. Check with
`curl -s http://127.0.0.1:11434/api/tags | grep '"name"'` before listing it here.

### 6.1b Dedicated local server LLM — 폐기 (server model deployment abandoned)

**This subsection documents an abandoned plan.** There is no Ubuntu GPU host in
this product's request path, no SSH tunnel, no 8000/8787/4318 port split, and no
plan to deploy a model on a server. The configuration below is kept only as the
record of what was considered; it is not active in the shipped allowlist and must
not be read as a deployment instruction.

A dedicated foreground model served via llama-server, vLLM or Ollama on a server
GPU would have been a `server_local` upstream entry; `gateway.config.example.json`
carries that slot as `server_gpu` at `http://127.0.0.1:8080/v1`, which nothing
serves.

For the 27B IQ3_S thinking model that plan was about, an independent check
confirms a public alias of `Qwen3.8` and a HuggingFace GGUF repository candidate
(`Qwen3.8-27B-Thinking-GGUF`), but the exact local model card artifact and any
live server deployment remain unproven. The model is **폐기/not active**: no
executable alias is enabled by default, and it is preserved only as a candidate
record under `_candidates_not_active`:

```jsonc
{
  "id": "server/qwen3.8-27b-iq3s",
  "display_name": "Qwen 27B IQ3_S Thinking (server GPU, candidate-only)",
  "capabilities": ["chat"],
  "zero_data_retention": true,
  "training_opt_out": true,
  "context_window": 32768,
  "thinking_limit": 8192,
  "metadata": {
    "format": "GGUF",
    "quant": "IQ3_S",
    "parameter_size": "27B",
    "thinking": true,
    "public_alias_verified": "Qwen3.8",
    "hf_candidate": "Qwen3.8-27B-Thinking-GGUF",
    "reference_thinking_limit": 8192,
    "reference_source": "screenshot configuration (not architecture proof)"
  }
}
```

Important operational rules for reasoning and thinking:
- **Strict field and bound validation**: `reasoning_effort` must be one of `low`, `medium`, `high`. `thinking` must be an object with `type` in `["enabled", "disabled"]` and positive integer `budget_tokens`. `thinking_budget` must be a positive integer. Any budget exceeding the model's configured `thinking_limit` (or non-integer/fraction/string/boolean/object forms) is rejected with `400 invalid_parameter` before upstream calls or quota reservation.
- **Fail-closed on unsupported models**: Models without a configured `thinking_limit` fail immediately with `400 unsupported_parameter` if reasoning controls are supplied.
- **Quota reservation upper bound without double count**: The token reservation is calculated as `max(completion_budget, thinking_budget)`, recognizing that `max_tokens` includes thinking tokens under OpenAI compatibility.
- **Policy enforcement preserved on all verbs**: All routes (`POST /v1/chat/completions`, `POST /v1/images/generations`, `POST /v1/videos`, `GET /v1/videos/{id}`, and `GET /v1/videos/{id}/content`) enforce the incoming `x-route` header and refuse `local_only` with `400 local_only_not_served` with zero upstream requests.

### 6.2 OpenRouter as `proxy`, with the operator's key

```jsonc
{
  "id": "openrouter",
  "class": "proxy",
  "base_url": "https://openrouter.ai/api/v1",
  "auth_mode": "gateway_key",
  "key_env": "OPENROUTER_API_KEY",
  "models": [
    { "id": "deepseek/deepseek-v4.1-flash-1017", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true, "context_window": 131072 },
    { "id": "anthropic/claude-sonnet-4.5", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true, "context_window": 1000000 }
  ]
}
```

`gateway_key` means the key lives in one environment variable, is read once at
startup, is never logged, never returned, and is used only for this upstream.

### 6.3 A6API as `proxy`, BYOK, and not ZDR

A6API is recorded in this project's own audit as non-ZDR: `zero_data_retention:
false`, `training_opt_out: false` (`40_AI보고서/engine/registry.py:553`, the
`a6api/deepseek-chat-v3.1` entry). It is the only catalogue entry with both flags
false. `gateway.config.example.json` carries it with exactly those values. So:

```jsonc
{
  "id": "a6api",
  "class": "proxy",
  "base_url": "https://a6api.vip/v1",
  "auth_mode": "pass_through",       // the client supplies its own key
  "models": [
    { "id": "a6api/deepseek-chat-v3.1", "capabilities": ["chat"],
      "zero_data_retention": false, "training_opt_out": false, "context_window": 163840 }
  ]
}
```

Consequence, enforced by the gateway and covered by a test: a `zdr_cloud` request
for `a6api/deepseek-chat-v3.1` is refused with `403 route_policy_violation` before
any upstream call. The `base_url` above was not verified by this project against a
live A6API endpoint; treat it as the config slot and confirm it before relying on
it.

### 6.4 `direct`

```jsonc
{
  "id": "baseten",
  "class": "direct",
  "base_url": "https://inference.baseten.co/v1",
  "auth_mode": "gateway_key",
  "key_env": "BASETEN_API_KEY",
  "models": [
    { "id": "baseten/mammoth-1", "capabilities": ["chat"],
      "zero_data_retention": true, "training_opt_out": true, "context_window": 16384 }
  ]
}
```

## 7. Route policy

`route` comes from the `x-route` header or the `route` body field.

Absent versus present:

- **Absent** means the source supplied nothing at all — no `x-route` header, and no
  `route` key in the body. That is the only case that falls back to
  `route.default`, which is what every pre-existing client relies on.
- **Present** means the caller actually sent something. Anything sent that is not
  one of the three routes is refused with `400 invalid_route`, and the refusal
  names the offending value (`error.detail.route`), its source
  (`error.detail.source` = `header` or `body`) and, for a non-string body value,
  its JSON type in `error.message` — plus the accepted set. An empty string, a
  whitespace-only value, `false`, `0`, `null`, an array or an object are all
  values the caller supplied, so they are refused rather than read as "unset".
  Nothing is ever replaced by the default: a caller who asked for a plane the
  gateway cannot read is not quietly rerouted to another one.

| route | effect |
| --- | --- |
| `local_only` | Standalone listener: **refused** with `400 local_only_not_served`. In-process (what the app runs): **served**, but only from an allowlisted loopback `server_local` upstream — a cloud provider is never its fallback. |
| `zdr_cloud` | Only models with `zero_data_retention: true` **and** `training_opt_out: true`, each checked independently. A violation is `403 route_policy_violation` and never downgraded. |
| `any_cloud` | No retention filter, but the model must still be in this gateway's allowlist; an unlisted model is `404 model_not_allowed` on every route. |

Both header and body may be sent; if they carry different valid routes the request
is refused (`400 route_conflict`) rather than one being chosen.

### Consent is unattested by the policy layer, checked by the app

The policy module itself carries no consent attestation: it holds the user's explicit choice, refuses
to open a socket for a cloud route without it, and reports every request as
`consent: "unattested"` (`CONSENT_ATTESTATION`). There is deliberately **no consent
attestation header** that the policy layer would trust: a boolean a caller can set
would attest to nothing, and treating one as proof would turn an unverifiable claim
into access. Access there is decided only by the route plus the model's catalogue
flags. `any_cloud` is still served — it is the caller's own explicit trade-off, and
no model flag is asserted for it — while `zdr_cloud` never relies on a claim: it
requires the allowlist entry itself to declare both retention flags, and refuses
when it does not.

In the product path the app is that gate: `app/lib/inference.mjs`'s `authorize`
requires the request's `x-app-session` token to name a live session with the same
route and identity and `consent === true`, or it answers `403 consent_required`
before any upstream call. A spoofed consent header changes nothing; a token from
another route or identity is `403 session_route_mismatch`.

A gateway started on its own by `gateway/server.mjs` has no conversation to
consult, so it installs a gate of its own (`lib/consent.mjs`,
`requireConsentForCloud`): a route that is not `local_only` is refused with
`403 consent_required` unless the request states consent with `x-consent: true`
(or `1`). Without this the standalone process relayed cloud traffic with no
consent check at all, because the handler's `authorize` default is a no-op. The
header is a caller's own statement, exactly like the app's storefront toggle — it
attests that the person at the keyboard agreed, and nothing more.
(`CONSENT_ATTESTATION` in `lib/policy.mjs`), and access is decided only by the
route plus the model's catalogue flags. `any_cloud` is still served — it is the
caller's own explicit trade-off, and no model flag is asserted for it — while
`zdr_cloud` never relies on a claim: it requires the allowlist entry itself to
declare both retention flags, and refuses when it does not.

### 7.1 Automatic model and reasoning selection

Omitting `model` means the gateway picks one; naming it is never overridden. Keys
that are present but unreadable (`null`, `''`, `'   '`, a number) keep their
existing `400 model_required`. The pick is deterministic for identical inputs and
stays inside `/v1/models`:

| rule | condition |
| --- | --- |
| `auto:server_local` | a `server_local` upstream (the prompt stays on this host) |
| `auto:zdr_declared` | a model declaring `zero_data_retention` **and** `training_opt_out` |
| `auto:route_conforming` | any remaining route-conforming allowlisted model |

`zdr_cloud` filters candidates to models declaring both flags before any rule
runs, so it can never receive a non-conforming model; if none exists the answer
is `503 no_model_available_for_route`, never a fallback. Inside a rule, candidates
order by usable credential, then context fit (fits / unknown / does not fit), then
model id ascending. A caller who asks for actual reasoning and leaves the model
open (`reasoning_effort`, `thinking_budget`, or a `thinking` object that is not
`disabled`) is served from the conforming models declaring `thinking_limit` when
one exists (`reasoning_required: true`). An explicitly disabled thinking request
asks for less work, not more, so it narrows nothing and keeps the local-first
pick. When no servable thinking-capable model exists on the route, the request
falls back to the normal route-conforming model and is then refused with
`400 unsupported_parameter` naming that model: the caller's reasoning request is
neither silently downgraded nor answered by a model outside the route.

The reasoning grade (`low` | `medium` | `high`) is scored from prompt tokens,
requested output tokens, tool use and route; `low` = 0–1 points, `medium` = 2–3,
`high` = 4+. Its budget is the grade base (1024 / 4096 / 8192) clamped to the
model's `thinking_limit`, and it is lowered until the reservation fits the
remaining daily tokens. A model with no `thinking_limit` gets no thinking
parameter at all.

Every response carries `gateway.model` and `gateway.reasoning` (plus
`x-gateway-model-*`, `x-gateway-reasoning-*`, `x-gateway-thinking-budget`
headers) where `source` is `gateway`, `caller` or `none`, and `reason` is the rule
that fired. `assumptions` names any catalogue field the decision needed but the
config omits — currently `context_window_not_declared` (fit left unchecked),
`model_declares_no_thinking_limit` (the model declares no `thinking_limit`, so
the grade list is empty and nothing is sent), and
`quota_headroom_unknown_treated_as_zero` (the remaining daily tokens are not
reported, so the reservation is checked against zero); an empty list means
nothing was assumed.
`supported_grades_basis` says the grade list is `derived_from_thinking_limit`,
because the catalogue declares a limit, not a per-grade capability.

### 7.1b The 2-track plan, and what the turn actually runs

Before a model is picked the gateway classifies the turn into `direct_execute` or
`survey_and_plan` and proposes a plan (tier, thinking budget, worker count, the
four-stage directive). That proposal passes the validator twice, because the rules
cannot all be checked at the same moment:

| rule | checked | what a failure does |
| --- | --- | --- |
| V-01 track | before selection | unknown track → conservative default |
| V-02 tier | before selection | tier must match the track; mismatched tier narrowed |
| V-03 thinking | before selection | direct execution carries no thinking; planturns clamp to 1..`MAX_THINKING` |
| V-04 workers | before selection | direct = 1; `survey_and_plan` = 2..`MAX_WORKERS` (a one-worker plan is raised, not accepted) |
| V-05 directive | before selection | a plan with no directive degrades to direct execution |
| V-06 model pin | after selection | a pinned model outside the allowlist is dropped |
| V-07 reasoning | after selection | a grade that is not `low`/`medium`/`high`, or a grade with no thinking budget, is not forwarded |
| V-08 budget | after selection | an estimate above `optimization.budget_cap_usd` degrades the plan to `direct_execute` |

The second pass (`enforcePlanAgainstModel` in `lib/selection.mjs`) prices the
request against the chosen model, so what runs is the degraded plan, not the
proposal: headers, the selection record and the outbound payload all report the
served plan. When the served track is `survey_and_plan`, the directive is sent as
the leading `system` message — a directive that only appears in a record was never
sent, and the record must not imply otherwise. A direct call that names `model`
skips planning entirely (`source: "caller"`) and carries no directive.

`optimization.pin_cache_ttl_ms` is the pin window the chat path uses; the parsed
value is applied to the pin store when the handler is built, so configuring it
changes when a pin expires.

### 7.2 Reading the decision back: `GET /v1/selection`

A streaming completion relays provider bytes verbatim, so the decision above is
visible only in response headers and a client that wants to label the model it was
served has nothing to read afterwards. This read-only endpoint is that answer: the
last automatic decision for the calling identity and route.

```json
{"selection":{"sequence":7,"decided_at":"2026-11-06T10:12:31.004Z","capability":"chat","route":"zdr_cloud",
  "model":{"id":"deepseek/deepseek-v4.1-flash-1017","upstream":"openrouter","source":"gateway","reason":"auto:zdr_declared"},
  "reasoning":{"source":"gateway","reason":"auto:grade_medium","grade":"medium","thinking_budget":4096}}}
```

- `{"selection":null}` is a real answer: before any decision, for an
  identity+route that has not been decided, and for a restarted process.
- Same identity header as chat. Missing → `401 identity_required`. Unknown route →
  the chat route's own `400 invalid_route` with the accepted set. Reading costs no
  quota. Route *policy* is not re-evaluated here — no model is chosen and no socket
  is opened — so `local_only` (which no chat request is served on) simply has no
  decision to report and reads back `null`.
- In memory only: one record per identity+route, capacity **16** (the least
  recently decided entry is evicted and reads back as `null`), nothing on disk,
  nothing across a restart. The quota ledger stays the only persisted state.
- No prompt text, message content, keys, cache keys or headers are stored or
  returned; `cache-control: no-store`.
- The record is the last decision **per identity+route**, not per message: two
  sessions with the same identity and route read the same record and may therefore
  show the same model. It carries no token, cost or savings figure, and none is
  established anywhere.

## 8. Quota ledger

- Identity: the `x-user-id` header, an opaque token (`A-Z a-z 0-9 . _ : -`,
  1-128 chars). Missing → `401 identity_required`.
- Caps: `quota.requests_per_day` and `quota.tokens_per_day`, per identity, per UTC
  day. Hit either and the answer is `429 quota_exceeded` with `retry-after`,
  `x-ratelimit-*` headers, and the day's counters in `error.detail`.
- Persistence: `quota.ledger_path` is written atomically (temp file + rename) on
  every change. A restart re-reads it, so a capped identity stays capped. A ledger
  that exists but cannot be parsed is a hard startup failure, not an empty one.
  Transient Windows replace errors are retried within a bounded ~140 ms budget
  before failing loudly. `quota.ledger_path` must be a local, non-synced path
  (not OneDrive, Dropbox, SMB or a network share): every retry blocks the
  single-threaded gateway, so a slow or externally-held file can stall requests
  before an honest `500`.
- Unknown usage is recorded as unknown. `tokens` counts only what the provider
  reported; a response with no usable `usage` block increments `unknown_usage` and
  leaves `tokens` untouched. `usage: {prompt_tokens: 0}` from a provider is *not*
  treated as unknown, because zero is what it said.
- Video is metered twice on the same ledger: submission (at `202`) and completion
  (on the poll that first observes a terminal state — a repeat poll does not
  charge again).
- Images are metered like chat: one request unit, plus reported tokens.

## 9. Key custody

Two modes, set per upstream by `auth_mode`:

- `gateway_key`: the key comes from the environment variable named by `key_env`,
  is read once, and is used only for that upstream. Missing or shorter than 8
  characters → the model is refused with `503 gateway_key_missing` /
  `gateway_key_too_short` before the upstream is contacted.
- `pass_through` (BYOK): the client's `Authorization: Bearer ...` is forwarded to
  that upstream unchanged. Nothing is stored. No header → `401 client_key_required`.
- `none`: no credential is sent (a loopback model server).

Every registered key is passed to the redactor. Log lines and response bodies are
redacted twice: once on the structured fields, once on the serialised JSON line.
The stream relay inspects each chunk and rewrites only the chunks that actually
contain a registered secret, so normal SSE bytes pass through untouched. `/healthz`
reports key environment variable *names* and booleans, never values.

## 10. Logging

Structured JSON lines, one per event: `gateway_starting`, `upstream_probe`,
`chat_request`, `chat_completed`, `chat_upstream_error`, `video_submitted`,
`video_terminal`, `request_refused`, and so on. Fields are identity, model,
upstream, route, status, token counts, and latencies. Prompt content is **not**
logged by default; only lengths and counts.

`logging.log_request_bodies: true` logs full bodies and prints a warning to stderr
and a `request_body_logging_enabled` record at startup. Do not run that with real
user content.

## 11. GPU state, honestly

`nvidia-smi` is **never invoked**. On the deployment host its kernel module is
595.84 against userspace 595.99 (NVML error 18), and the lab will not reboot that
server, so the failure is **permanent, not transient**. A number from it would be a
guess wearing a uniform, and it will not start working later.

The only acceptable sources of GPU state are `libcuda` semantics
(`cuMemGetInfo`-style occupancy from a live CUDA context) or a runtime that already
holds that context and exposes it — here, Ollama's `/api/ps`. This gateway
implements the Ollama path. It does not link `libcuda`, so it never claims
`cuMemGetInfo` numbers; if the runtime in front of the GPU does not report
occupancy, the gateway reports unknown.

`/healthz` reports GPU state per upstream and in aggregate:

- `"reported"` only when a real source reported it — currently Ollama's
  `/api/ps`, summed over `size_vram`, with the source named.
- `"unknown"` otherwise, with a note saying why. Unknown never renders as zero and
  never counts as healthy. Free VRAM capacity is not reported by `/api/ps`, so it
  is stated as unknown rather than derived from a total minus a sum.

## 12. Upstream availability

`/v1/models` lists the configured allowlist whether or not upstreams are up: it is
a policy list, not a liveness list. `/healthz` is the liveness view and returns
`503` naming every unreachable upstream. A request to a down upstream fails
immediately with `502 upstream_unreachable` and the URL it tried — no hanging, no
retry loop, no quiet failover to another provider.

## 13. What was actually verified

Everything below was executed on this machine on 2026-11-04; the suite totals in
13.1 were re-measured on 2026-11-09. Node `v26.13.0` on
Windows. Stub upstream on `127.0.0.1:8799`; gateways on `127.0.0.1:8787` (stub
config), `127.0.0.1:8788` (quota config), and `127.0.0.1:8000` (the example config,
which is the port the tunnel forwards). No real provider was contacted and no real
API key was used; the two keys in the run were fabricated strings.

### 13.1 Tests

```
$ node --test gateway/test/*.test.mjs
ℹ tests 156
ℹ suites 0
ℹ pass 156
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10283
exit code 0
```

Automated suite (**156 pass, 0 fail, 0 skip**: the contained baseline following withdrawal of the failed prompt cache key integration, plus the selection read-back and the runtime-enforcement tests). Covered behaviour, each against the stub upstream:

- runtime enforcement (`test/runtime-enforcement.test.mjs`): a `survey_and_plan` turn really sends the four-stage directive as the leading system message; a configured `optimization.budget_cap_usd` degrades the plan to `direct_execute` and reports `V-08`; the served plan (not the proposed one) is what the headers and the selection record report; the configured `optimization.pin_cache_ttl_ms` is the window `SESSION_PINS` uses; a survey plan proposed with one worker is raised to two and reported as `V-04`; the standalone consent gate refuses a cloud route with `403 consent_required` on both the header and the body route and allows a stated one
- non-null `prompt_cache_key` explicitly rejected with `400 unsupported_parameter`; `x-session-id` alone injects no key; base credential redaction and relay restored
- `GET /v1/selection`: `{selection:null}` before any decision and after a restart, the last decision per identity+route only (another identity or another route reads `null`), least-recently-decided eviction at capacity, `401 identity_required` without the identity header, the chat route's `400 invalid_route` for an unknown route, no quota charge, and `cache-control: no-store`
- streaming passthrough (frames relayed verbatim, `[DONE]` preserved, usage parsed)
- non-streaming completion, with non-allowlisted request fields dropped
- a model outside the allowlist refused, with the upstream request count unchanged
- `local_only` refused by the gateway, upstream untouched
- `zdr_cloud` blocked for A6API (`zero_data_retention: false`) and for the `direct`
  class model that lacks `training_opt_out`; the same A6API model then succeeds on
  `any_cloud` with the client's BYOK key forwarded
- quota exhaustion → `429`, per-identity isolation, counters surviving a restart
- provider errors relayed with the provider's status and code
- malformed upstream bodies handled in both modes without crashing
- `/v1/models` equal to the allowlist, with class and retention per model
- `/healthz` ok, then `503` with a named unreachable upstream while `/v1/models`
  keeps listing
- the configured key absent from the log file and from every error body
- pass-through auth refusing a missing client key without spending quota
- a route header/body disagreement refused
- the image route: proxied, allowlisted, capability-checked, policy-checked, metered
- the video job contract: `queued → running → succeeded`, artifact fetch, one
  completion charge, other-identity isolation, `409` before ready, `503` when no
  video upstream is configured
- upstream class reporting and per-class auth (no credential for `server_local`,
  the operator's key for `key_env`, the client's key for `pass_through`)
- config rejection: duplicate model id, non-loopback `server_local`, ollama outside
  `server_local`, non-loopback bind without the opt-in
- Ollama probed via `/api/tags` and `/api/ps`; GPU `unknown` when `size_vram` is
  absent; unreachable Ollama reported unreachable
- health cache honoured within its TTL, re-probed when invalidated
- the fd-limit reporter parsing real `/proc/self/limits` values and reporting
  unknown when it has no source
- prompt content absent from the log by default, and present only when
  `logging.log_request_bodies` is on (with the provider key still redacted)
- the shipped `gateway.config.example.json` loads, keeps the audited A6API flags
  (`zero_data_retention: false`, `training_opt_out: false`), carries the three real
  Ollama model ids, and has 11 unique model ids across the five upstreams

### 13.2 Real HTTP requests against the running service

```
$ node stub/stub-upstream.mjs            # 127.0.0.1:8799
stub upstream listening on http://127.0.0.1:8799
base paths: /local/v1, /openrouter/v1, /a6api/v1, /direct/v1

$ node server.mjs --config gateway.config.stub.json
{"event":"gateway_listening","url":"http://127.0.0.1:8787","version":"0.1.0"}
{"event":"listen_address","host":"127.0.0.1","port":8787,"loopback_only":true,"allow_non_loopback_bind":false}
```

The captured status lines of one full pass, in the order issued:

```
GET /healthz                 HTTP 200
GET /v1/models               HTTP 200
POST chat (json)             HTTP 200
POST chat (stream)           HTTP 200
POST chat (bad model)        HTTP 404
POST chat (local_only)       HTTP 400
POST chat (a6api zdr)        HTTP 403
POST chat (a6api any_cloud)  HTTP 200
POST images                  HTTP 200
POST videos                  HTTP 202
GET  /v1/videos/{id} #1      HTTP 200   running, 0.5
GET  /v1/videos/{id} #2      HTTP 200   succeeded, 1
GET  /v1/videos/{id} #3      HTTP 200   succeeded again, no second charge
GET  /v1/videos/{id}/content HTTP 200
--- stub killed, health cache allowed to expire ---
GET /healthz (stub down)     HTTP 503
GET /v1/models (stub down)   HTTP 200   (all 7 still listed)
POST chat (stub down)        HTTP 502
```

`GET /healthz` → `200`, `ok: true`, five upstreams reachable, and:

```json
"gpu": { "state": "reported",
         "sources": [ { "upstream": "ollama",
                        "source": "/api/ps (sum of size_vram)",
                        "note": "total VRAM capacity is not reported by /api/ps, so free VRAM is unknown" } ] },
"upstreams": [ { "id": "ollama", "upstream_class": "server_local", "upstream_kind": "ollama",
                 "reachable": true, "status": 200,
                 "advertised_models": ["qwen2.5:72b","qwen3:32b","qwen2.5:32b","qwen3-embedding:0.6b"],
                 "loaded_models": [ { "name": "qwen3:32b", "size_vram_bytes": 19500000000 } ],
                 "gpu": { "state": "reported", "vram_in_use_bytes": 19500000000 } },
               { "id": "server_gpu", "gpu": { "state": "unknown" } }, ... ]
```

`GET /v1/models` → `200`, the seven models of `gateway.config.stub.json`, each with
`upstream_class` and retention flags; the A6API entry comes back with
`"zero_data_retention": false`.

Non-streaming chat, `200`:

```json
{"id":"stub-completion-1","object":"chat.completion","model":"deepseek/deepseek-v4.1-flash-1017",
 "choices":[{"index":0,"message":{"role":"assistant",
   "content":"stub reply to: Explain a Kafka consumer group in one sentence."},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}
```

Streaming chat, `200`. Response headers, captured verbatim:

```
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-store
connection: keep-alive
x-accel-buffering: no
x-gateway-model: deepseek/deepseek-v4.1-flash-1017
x-gateway-upstream: openrouter
Date: Wed, 04 Nov 2026 11:45:53 GMT
Transfer-Encoding: chunked
```

Body, captured verbatim:

```
data: {"id":"stub-1","object":"chat.completion.chunk","model":"deepseek/deepseek-v4.1-flash-1017","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}

data: {"id":"stub-1","object":"chat.completion.chunk","model":"deepseek/deepseek-v4.1-flash-1017","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"stub-1","object":"chat.completion.chunk","model":"deepseek/deepseek-v4.1-flash-1017","choices":[{"index":0,"delta":{"content":" from"}}]}

data: {"id":"stub-1","object":"chat.completion.chunk","model":"deepseek/deepseek-v4.1-flash-1017","choices":[{"index":0,"delta":{"content":" the"}}]}

data: {"id":"stub-1","object":"chat.completion.chunk","model":"deepseek/deepseek-v4.1-flash-1017","choices":[{"index":0,"delta":{"content":" stub"}}]}

data: {"id":"stub-1","object":"chat.completion.chunk","model":"deepseek/deepseek-v4.1-flash-1017","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}

data: [DONE]
```

Refused model, `404`:

```json
{"error":{"message":"model openai/gpt-5-not-configured is not in this gateway's allowlist; it will not be forwarded upstream",
 "type":"invalid_request_error","code":"model_not_allowed","param":"model",
 "detail":{"requested":"openai/gpt-5-not-configured","capability":"chat",
  "permitted":["a6api/deepseek-chat-v3.1","baseten/mammoth-1","deepseek/deepseek-v4.1-flash-1017","qwen2.5:72b","qwen3:32b"]}}}
```

`local_only` refusal, `400`:

```json
{"error":{"message":"local_only is refused by the gateway: the local plane runs directly on the host and does not traverse this gateway; call the local runtime endpoint directly, or resend with route zdr_cloud or any_cloud",
 "type":"invalid_request_error","code":"local_only_not_served","param":"route"}}
```

`zdr_cloud` against the non-ZDR A6API model, `403`:

```json
{"error":{"message":"model a6api/deepseek-chat-v3.1 is not zero-data-retention (zero_data_retention=false, training_opt_out=false) and may not be reached on route zdr_cloud; the gateway will not downgrade the route for you",
 "type":"permission_error","code":"route_policy_violation","param":"route",
 "detail":{"route":"zdr_cloud","model":"a6api/deepseek-chat-v3.1","upstream":"a6api","upstream_class":"proxy",
  "zero_data_retention":false,"training_opt_out":false,"capability":"chat"}}}
```

Image generation, `200`:

```json
{"created":1700000000,"data":[{"b64_json":"c3R1Yi1pbWFnZTphIHJhaW4tc29ha2VkIHNlcnZlciB0b3dlcg=="}],"usage":{"total_tokens":12}}
```

Video submit, `202` with `location: /v1/videos/vid_3c0929e54e6b42cf86ac8efb`:

```json
{"id":"vid_3c0929e54e6b42cf86ac8efb","object":"video.job","model":"server/wan-2.2-t2v",
 "status":"queued","progress":null,"upstream":"server_gpu","upstream_job_id":"job_4c0f1297c16e",
 "artifact":null,"error":null,"quota_charged_on":"submission and completion"}
```

Three polls returned, in order, `"status": "running", "progress": 0.5`, then
`"status": "succeeded", "progress": 1` with
`"artifact": {"url": "stub://artifact/job_4c0f1297c16e", "content_url": "/v1/videos/vid_3c09.../content"}`,
then the same terminal job again without a second charge. `GET .../content` returned
`200`, body `stub-video-bytes:job_4c0f1297c16e`, 33 bytes.

The same A6API model on `any_cloud`, with the client's own key in `Authorization`
and no key of ours involved, `200`:

```json
{"id":"stub-completion-1","object":"chat.completion","model":"a6api/deepseek-chat-v3.1",
 "choices":[{"index":0,"message":{"role":"assistant","content":"stub reply to: send this through the a6 proxy"},
   "finish_reason":"stop"}],
 "usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}
```

`gateway.config.example.json`, which carries the Ollama upstream and dedicated server GPU models alongside the two proxies and the direct provider, carries 11 models in its allowlist and health tells the truth about every one:

```
GET /healthz    HTTP 503   ok: false, status: degraded, unreachable_upstreams: all five
GET /v1/models  HTTP 200   11 models: qwen2.5:72b, qwen3:32b, qwen2.5:32b,
                           server/qwen3-coder-30b, server/flux-schnell, server/wan-2.2-t2v,
                           deepseek/deepseek-v4.1-flash-1017, anthropic/claude-sonnet-4.5,
                           google/gemini-2.5-flash, a6api/deepseek-chat-v3.1, baseten/mammoth-1
startup line    listen=127.0.0.1:8000  allowlist=11  default_route=zdr_cloud
```

That is the required split: the catalogue is a policy list and stays complete, the
health view is a liveness list and admits the outage. The `ollama` entry's GPU state
in that run was `"unknown"`, not zero and not healthy, because nothing answered at
`127.0.0.1:11434` on this machine.

Upstream failures, each with the real status this gateway returned:

```
provider error, relayed   HTTP 429   {"error":{"message":"openrouter: stub upstream is rate limiting you",
                                       "type":"upstream_error","code":"upstream_error",
                                       "detail":{"upstream":"openrouter","upstream_status":429,
                                                 "upstream_code":"stub_rate_limited"}}}
malformed JSON, non-stream HTTP 502   {"error":{"message":"upstream openrouter returned a body that is not
                                       valid JSON for a non-streaming completion","type":"upstream_error",
                                       "code":"upstream_bad_response","detail":{"upstream":"openrouter","bytes":66}}}
malformed frames, streaming HTTP 200  the good frame is relayed, the unparseable one is counted and skipped,
                                       the process stays up; GET /v1/models still 200 afterwards
```

The provider's own status survives (`429`, not a rewritten `502`), and its message
is prefixed with the upstream id so a client can tell which provider spoke. A
malformed body is not swallowed into a fake success and does not take the process
down.

With the video model removed from a copy of the config, video answers "not
configured" instead of pretending. `POST /v1/videos` and `GET /v1/videos/{id}` both
return `503`, and `/healthz` says `"video": {"configured": false, "upstreams": []}`:

```json
{"error":{"message":"no video upstream is configured: this gateway has no allowlisted model with the video capability, so it cannot submit or track video jobs",
 "type":"configuration_error","code":"video_not_configured","param":null,
 "detail":{"configured_video_models":[],
  "hint":"add a model with capabilities [\"video\"] and a video path block to the config"}}}
```

Quota exhaustion, `429`, on a second gateway with `requests_per_day: 2` and
`tokens_per_day: 200`. The first two requests returned `200`; the third and fourth:

```
HTTP/1.1 429 Too Many Requests
content-type: application/json; charset=utf-8
content-length: 643
cache-control: no-store
x-ratelimit-remaining-requests: 0
x-ratelimit-limit-requests: 2
x-ratelimit-limit-tokens: 200
retry-after: 44552

{"error":{"message":"daily request cap reached for identity quota-user: 2 of 2 requests used today; resets at 00:00 UTC",
 "type":"rate_limit_error","code":"quota_exceeded","param":null,
 "detail":{"identity":"quota-user","day":"2026-11-04",
  "limits":{"requests_per_day":2,"tokens_per_day":200},
  "used":{"requests":2,"tokens":24,"unknown_usage":0,"images":0,"video_submissions":0,"video_completions":0},
  "remaining":{"requests":0,"tokens":176}}}}
```

The ledger on disk at that moment:

```json
{"version":1,"users":{"quota-user":{"2026-11-04":{"requests":2,"tokens":24,"unknown_usage":0,
  "reserved_requests":0,"reserved_tokens":0,"images":0,"video_submissions":0,"video_completions":0}}}}
```

The gateway process (pid 8136) was then killed outright — confirmed dead — and a
fresh process (pid 4008) was started on the same config and the same ledger file.
In that new process the same identity still got `429` with `"used": {"requests": 2,
"tokens": 24}`, and a different identity got `200`. The counters are on disk, not
in the process. The ledger is written to `<path>.tmp-<pid>` and renamed into place,
so a crash mid-write cannot leave a half-parsed file that would be read as an empty
one.

With the stub killed, `GET /healthz` → `503`, `"ok": false`. Every upstream is
listed with its own error, and GPU state collapses to unknown with a reason rather
than to zero:

```json
{"ok": false, "status": "degraded", "upstream_reachable": false,
 "gpu": { "state": "unknown", "states": ["unknown","unknown","unknown","unknown","unknown"], "sources": [] },
 "unreachable_upstreams": ["ollama","server_gpu","openrouter","a6api","baseten"],
 "upstreams": [ { "id": "ollama", "upstream_class": "server_local", "upstream_kind": "ollama",
                  "reachable": false, "status": null, "latency_ms": 3,
                  "gpu": { "state": "unknown", "source": null,
                           "note": "upstream unreachable; residency cannot be read" },
                  "error": "upstream ollama is unreachable at http://127.0.0.1:8799/ollama (ECONNREFUSED)" },
                { "id": "openrouter", "upstream_class": "proxy", "reachable": false,
                  "error": "upstream openrouter is unreachable at http://127.0.0.1:8799/openrouter/v1 (ECONNREFUSED)" },
                ... ] }
```

`GET /v1/models` in the same state → `200` with all seven stub-config models. A chat
request in the same state → `502`:

```json
{"error":{"message":"upstream openrouter is unreachable at http://127.0.0.1:8799/openrouter/v1 (ECONNREFUSED)",
 "type":"upstream_error","code":"upstream_unreachable","param":null}}
```

A config with `listen.host: "0.0.0.0"` was refused before any socket opened:

```
$ node server.mjs --config tmp-nonloopback.json
config error: listen.host: refusing to bind 0.0.0.0: only a loopback host is allowed unless
listen.allow_non_loopback_bind is set to true. This host is shared; bind 127.0.0.1 and
reach it through an SSH tunnel
exit code 2
```

### 13.3 Key redaction, checked by search

All three log files written across the whole run were searched for the two
configured key strings, the BYOK key the client sent through the A6API upstream,
and the literal prompt text used in the requests. Every one of them must be absent:

```
$ Select-String -Path data-stub\gateway.log,data-quota\gateway.log,data\gateway.log `
    -SimpleMatch 'sk-or-v1-VERIFYKEY0123456789abcdef','baseten-VERIFYKEY0123456789abcdef', `
                 'sk-or-v1-CLIENTBYOK','Explain a Kafka consumer group'
(no output)
```

Line counts searched: `data-stub\gateway.log` 31, `data-quota\gateway.log` 17,
`data\gateway.log` 10. The same search over every captured response body returned
nothing. So the keys appear in no log, no error body, and no response header, and
the default mode does not log prompt content at all.

The three `data*` directories were deleted after the run so the repository ships no
runtime state; copies of the logs, ledgers and every response body are kept outside
it under `<backup>\2026-11-04-gateway-verify\`, where the same
`Select-String` reproduces the empty result.

The order matters: this check ran after the stub-down pass, the quota restart pass,
and the BYOK pass, so the logs searched already contained an `upstream_unreachable`
error, a `429`, and a forwarded client key. The test suite asserts the same thing
programmatically, including with request-body logging switched on.

### 13.4 Process cleanup

The stub and the gateways were started as background processes and all were
stopped, each one confirmed gone by pid. The final check:

```
$ Get-CimInstance Win32_Process -Filter "Name='node.exe'"
(only an unrelated process from another tool, holding none of these ports)
$ netstat -ano | Select-String ':8000|:8787|:8788|:8799'
(no output)
```

No listener on 8000, 8787, 8788 or 8799 remained. The pids used and stopped in
these runs: the stub on several occasions, the stub-config gateway on 8787 (started
and restarted), the quota-config gateway on 8788 (pid 8136, killed and restarted as
pid 4008), and the example-config gateway on 8000 (twice). Each was checked dead
after `Stop-Process`. One `node` process belonging to a different tool on this
machine was running throughout and was left alone; it held none of these ports.

A note on one step in this process, because it matters for trusting the numbers:
during the verification several background processes were still holding the ports
when a later pass started, and `EADDRINUSE` was the error. Those passes were
discarded rather than reported, the stale processes were killed by pid, and the
runs reproduced in section 13 are the ones that started cleanly on a free port.
The transcript shows both, and only the clean ones are quoted.

## 14. Limits you should know

- **Residual limits of standalone & legacy artifacts:** `gateway/server.mjs` and
  `start.sh` remain an optional standalone listener that nothing in the app launches;
  legacy detached-endpoint helpers remain reachable only for mock/no-inference configurations;
  the bundled config's default upstream is the loopback demo stub (`127.0.0.1:8799`).
- **Nothing was deployed.** This is the artifact plus local verification. No file
  was written to the server, and the tunnel command above is documented from the
  audit, not exercised from here.
- **The image and video upstreams do not exist yet.** `server_gpu` in the example
  config points at `http://127.0.0.1:8080/v1`, where no inference server was
  running. Every image response and every video job in section 13 came from the
  stub at `:8799`. The `/v1/images/generations` and `/v1/videos` code paths are real
  and tested; the models behind them are not provisioned.
- **The primary server-plane 27B IQ3_S thinking model identity is unproven.**
  While independent review notes public aliases (`Qwen3.8`) and HF GGUF candidate repos
  (`Qwen3.8-27B-Thinking-GGUF`), the exact model card artifact and live server deployment
  remain unproven. The model is NOT active in the shipped example config or catalogue,
  and no guessed executable alias is enabled by default. It is preserved strictly as a
  candidate specification in `gateway.config.example.json` under `_candidates_not_active`.
  The reference thinking limit of 8192 reflects screenshot configuration rather than architecture proof.
  The server model deployment plan (27B, FLUX, server GPU residency, leasing) is completely abandoned (폐기).
- **Ollama was not reached live from this machine.** The Ollama upstream, its
  `/api/tags` and `/api/ps` behaviour, and its model names are exercised against a
  stub that reproduces those response shapes. The model names come from the
  deployment audit; the endpoint was never contacted. On the host, `/healthz` will
  probe it for real.
- **The A6API base URL is unconfirmed.** `https://a6api.vip/v1` is a placeholder
  slot from a third-party preset list. What is verified is the policy: an A6API
  model with both flags false is refused on `zdr_cloud`.
- **The selection record is process-local and per identity+route.** It holds one
  decision per identity+route (capacity 16, evicted least-recently-decided, resets on restart),
  is not written to disk, and contains no prompt text, keys or headers (`cache-control: no-store`).
  `GET /v1/selection` returns `{"selection":null}` before any decision, `401 identity_required`
  without identity header, and `400 invalid_route` on an unknown route. Two sessions sharing
  an identity and route read the same record. The limit is per identity+route, not per message.
  In this build the runtime's upstream is a local stub, so what is verified here is the decision
  reporting and the label transport, not real inference, and no token, cost or savings figure is established.
- **Video job handles are process-local.** They live in memory, so a restart
  forgets in-flight jobs. Quota counters are on disk; job state is not. Cancellation
  and idempotency keys are not implemented. A completed job's bytes are re-fetched
  through the upstream on every `content` call.
- **The fd-limit raise depends on Node exposing `setrlimit`.** When it does not
  (it did not on this Windows machine), `server.mjs` reads `/proc/self/limits` on
  Linux and reports the real numbers, while `start.sh`'s `ulimit -n` performs the
  raise before `exec`. On a platform with neither, it reports unknown and says so.
  This run reported `soft=unknown hard=unknown`, which is the honest answer here and
  will not be the answer on Ubuntu 24.04, where `/proc/self/limits` exists.
- **No TLS.** The gateway speaks HTTP on loopback; the SSH tunnel is the transport
  boundary (historical; tunnel is 폐기). Do not bind it to a routable interface without terminating TLS in
  front of it, and note the config guard exists to make that a deliberate act.
- **One process, in-memory job table, no horizontal scale.** Ledger correctness
  relies on a single writer; a second process over the same ledger file would race.
- **`Set-Cookie`-style multi-header pass-through is not attempted.** Response
  headers from upstream are not forwarded except for media type on artifact
  fetches.
