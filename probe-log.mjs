import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInference } from "./app/lib/inference.mjs";
import { localRuntime } from "./app/server.mjs";

const scratch = mkdtempSync(join(tmpdir(), "probe-log-"));
const rawInference = { upstreams: [{ id: "stub-main", class: "server_local", kind: "openai", base_url: "http://127.0.0.1:8799/local/v1", auth_mode: "none", models: [{ id: "stub-chat", capabilities: ["chat"], zero_data_retention: true, training_opt_out: true, context_window: 32768, thinking_limit: 8192 }] }] };
const inference = createInference({ raw: rawInference, appRoot: resolve("."), stateDir: scratch, identity: "test-user", sessions: new Map(), stdout: { write() {} } });
inference.prepareRuntime("http://127.0.0.1:4317/v1", null);
const t0 = Date.now();
const r = spawnSync(localRuntime.bun, [localRuntime.cli, "--mode", "rpc"], { input: JSON.stringify({id:"1",type:"negotiate_protocol",protocolVersion:2})+"\n"+JSON.stringify({id:"2",type:"get_available_models"})+"\n", encoding:"utf8", cwd: scratch, env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: inference.agentDir, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "", OMP_DEBUG: "1" } });
console.log("elapsed", Date.now()-t0, r.status);
const logDir = join(scratch, ".omp", "logs");
const findLogs = (d) => { let out = []; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) out = out.concat(findLogs(p)); else if (e.name.endsWith(".log")) out.push(p); } return out; };
for (const l of findLogs(scratch)) { console.log("=== " + l); console.log(readFileSync(l, "utf8").slice(0, 3000)); }
rmSync(scratch, { recursive: true, force: true });
