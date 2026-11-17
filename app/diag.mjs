import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
const bun = resolve("../.omp-runtime/node_modules/bun/bin/bun.exe");
const cli = resolve("../.omp-runtime/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const absOverlay = resolve("omp-overlay.yml");
const r = spawnSync(bun, [cli, "--config", absOverlay, "--mode", "rpc"], {
  input: JSON.stringify({ id: "1", type: "negotiate_protocol", protocolVersion: 2 }) + "\n" + JSON.stringify({ id: "2", type: "get_state" }) + "\n",
  encoding: "utf8", cwd: homedir(), timeout: 10000,
});
console.log(JSON.stringify({ status: r.status, signal: r.signal, err: r.error && String(r.error), stdoutLen: (r.stdout||"").length, stderrLen: (r.stderr||"").length }));
