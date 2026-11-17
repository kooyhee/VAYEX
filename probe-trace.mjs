import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInference } from "./app/lib/inference.mjs";
import { localRuntime } from "./app/server.mjs";

const scratch = mkdtempSync(join(tmpdir(), "probe-trace-"));
const rawInference = { upstreams: [{ id: "stub-main", class: "server_local", kind: "openai", base_url: "http://127.0.0.1:8799/local/v1", auth_mode: "none", models: [{ id: "stub-chat", capabilities: ["chat"], zero_data_retention: true, training_opt_out: true, context_window: 32768, thinking_limit: 8192 }] }] };
const inference = createInference({ raw: rawInference, appRoot: resolve("."), stateDir: scratch, identity: "test-user", sessions: new Map(), stdout: { write() {} } });
inference.prepareRuntime("http://127.0.0.1:4317/v1", { enabled:true, provider:"harness-local-small", model:"small-background", endpoint:"http://127.0.0.1:59999/v1" });
const t0 = Date.now();
const child = spawn(localRuntime.bun, [localRuntime.cli, "--mode", "rpc"], { cwd: scratch, env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: inference.agentDir, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "" } });
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let f; try { f = JSON.parse(line); } catch { console.log("+", Date.now()-t0, "unparsed", line.slice(0,80)); continue; }
    console.log("+", Date.now()-t0, "frame", f.type || "?", f.id || "", f.method || "");
  }
});
child.stderr.on("data", d => console.log("+", Date.now()-t0, "STDERR", d.toString().slice(0,300)));
child.on("exit", (c,s) => console.log("+", Date.now()-t0, "EXIT", c, s));
child.on("close", (c,s) => { console.log("+", Date.now()-t0, "CLOSE", c, s); rmSync(scratch,{recursive:true,force:true}); });
child.stdin.write(JSON.stringify({ id: "1", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
child.stdin.write(JSON.stringify({ id: "2", type: "get_available_models" }) + "\n");
child.stdin.end();
