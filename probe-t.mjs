import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInference } from "./app/lib/inference.mjs";
import { localRuntime } from "./app/server.mjs";

async function run(bg, label) {
  const scratch = mkdtempSync(join(tmpdir(), "probe-t-"));
  const rawInference = { upstreams: [{ id: "stub-main", class: "server_local", kind: "openai", base_url: "http://127.0.0.1:8799/local/v1", auth_mode: "none", models: [{ id: "stub-chat", capabilities: ["chat"], zero_data_retention: true, training_opt_out: true, context_window: 32768, thinking_limit: 8192 }] }] };
  const inference = createInference({ raw: rawInference, appRoot: resolve("."), stateDir: scratch, identity: "test-user", sessions: new Map(), stdout: { write() {} } });
  inference.prepareRuntime("http://127.0.0.1:4317/v1", bg);
  const t0 = Date.now();
  const child = spawn(localRuntime.bun, [localRuntime.cli, "--mode", "rpc"], { cwd: scratch, env: { ...process.env, HOME: scratch, USERPROFILE: scratch, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: inference.agentDir, OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_FILES: "" } });
  child.stdin.write(JSON.stringify({ id: "1", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
  child.stdin.write(JSON.stringify({ id: "2", type: "get_available_models" }) + "\n");
  child.stdin.end();
  child.stdout.on("data", d => { const s = d.toString(); if (s.includes("\"id\":\"2\"")) console.log(label, "frame2 at", Date.now()-t0); });
  child.stderr.on("data", d => console.log(label, "stderr", d.toString().slice(0,500)));
  child.on("exit", (c, s) => { console.log(label, "exit at", Date.now()-t0, c, s); rmSync(scratch, { recursive: true, force: true }); });
  await new Promise(r => child.on("close", r));
}
await run(null, "unset");
await run({ enabled:true, provider:"harness-local-small", model:"small-background", endpoint:"http://127.0.0.1:11434/v1" }, "live-endpoint");
await run({ enabled:true, provider:"harness-local-small", model:"small-background", endpoint:"http://127.0.0.1:59999/v1" }, "dead-endpoint");
