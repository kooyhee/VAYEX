import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInference } from "./app/lib/inference.mjs";
import { localRuntime } from "./app/server.mjs";

function run(bg, label) {
  const scratch = mkdtempSync(join(tmpdir(), "probe-bg-"));
  const rawInference = { upstreams: [{ id: "stub-main", class: "server_local", kind: "openai", base_url: "http://127.0.0.1:8799/local/v1", auth_mode: "none", models: [{ id: "stub-chat", capabilities: ["chat"], zero_data_retention: true, training_opt_out: true, context_window: 32768, thinking_limit: 8192 }] }] };
  const inference = createInference({ raw: rawInference, appRoot: resolve("."), stateDir: scratch, identity: "test-user", sessions: new Map(), stdout: { write() {} } });
  inference.prepareRuntime("http://127.0.0.1:4317/v1", bg);
  const t0 = Date.now();
  const res = spawnSync(localRuntime.bun, [localRuntime.cli, "--mode", "rpc"], {
    input: JSON.stringify({ id: "1", type: "negotiate_protocol", protocolVersion: 2 }) + "\n" + JSON.stringify({ id: "2", type: "get_available_models" }) + "\n",
    encoding: "utf8", cwd: scratch,
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: inference.agentDir, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "" },
    timeout: 120000
  });
  const out = (res.stdout||"").split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).find(f=>f&&f.id==="2");
  console.log(label, "elapsed", Date.now()-t0, "status", res.status, "frame2", out ? "present" : "absent");
  rmSync(scratch, { recursive: true, force: true });
}

run(null, "unset");
run({ enabled:true, provider:"harness-local-small", model:"small-background", endpoint:"http://127.0.0.1:11434/v1", contextWindow:16384, maxTokens:2048 }, "set-live");
run({ enabled:true, provider:"harness-local-small", model:"small-background", endpoint:"http://127.0.0.1:59999/v1" }, "dead-endpoint");
