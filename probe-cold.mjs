import { performance } from "node:perf_hooks";
const { localRuntime } = await import("./app/server.mjs");
import { spawnSync } from "node:child_process";
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  const res = spawnSync(localRuntime.bun, ["--version"], { encoding: "utf8" });
  console.log("bun --version", res.stdout.trim(), "ms", Math.round(performance.now() - t0), "status", res.status);
}
