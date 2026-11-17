import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInference } from "./app/lib/inference.mjs";
import { localRuntime } from "./app/server.mjs";

function one(i) {
  return new Promise((res) => {
    const scratch = mkdtempSync(join(tmpdir(), "probe-par-"));
    const rawInference = { upstreams: [{ id: "stub-main", class: "server_local", kind: "openai", base_url: "http://127.0.0.1:8799/local/v1", auth_mode: "none", models: [{ id: "stub-chat", capabilities: ["chat"], zero_data_retention: true, training_opt_out: true, context_window: 32768, thinking_limit: 8192 }] }] };
    const inference = createInference({ raw: rawInference, appRoot: resolve("."), stateDir: scratch, identity: "test-user", sessions: new Map(), stdout: { write() {} } });
    inference.prepareRuntime("http://127.0.0.1:4317/v1", { enabled:true, provider:"harness-local-small", model:"small-background", endpoint:"http://127.0.0.1:59999/v1" });
    const t0 = Date.now(); let ready = null, resp = null;
    const child = spawn(localRuntime.bun, [localRuntime.cli, "--mode", "rpc"], { cwd: scratch, env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: inference.agentDir, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "" } });
    let buf = ""; child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let f; try { f = JSON.parse(line); } catch { continue; } if (f.type === "ready" && !ready) ready = Date.now()-t0; if (f.type === "response" && f.id === "2") resp = Date.now()-t0; } });
    child.stdin.write(JSON.stringify({ id: "1", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
    child.stdin.write(JSON.stringify({ id: "2", type: "get_available_models" }) + "\n");
    child.stdin.end();
    child.on("close", (c) => { rmSync(scratch,{recursive:true,force:true}); res({ i, ready, resp, exit: Date.now()-t0, c }); });
  });
}
const results = await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
console.log(JSON.stringify(results, null, 1));
