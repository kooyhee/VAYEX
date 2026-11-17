// `--profile both` is the CLI's compare mode, not a profile name. It used to be
// forwarded to `optimization.profile`, which the config refuses, so the documented
// command failed with ConfigError instead of running baseline and then optimized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profilesFor } from '../../gateway/bench/run-benchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here,'../../gateway/bench/run-benchmark.mjs');
const run = promisify(execFile);

test('profilesFor maps both to a baseline-then-optimized run and refuses names that are not profiles', () => {
  assert.deepEqual(profilesFor('both'),['baseline','optimized'],'both is a mode that runs baseline then optimized');
  assert.deepEqual(profilesFor('baseline'),['baseline']);
  assert.deepEqual(profilesFor('optimized'),['optimized']);
  for (const bad of ['profile','fast','both_','']) {
    assert.throws(() => profilesFor(bad),/--profile: must be one of baseline, optimized, both/,`${JSON.stringify(bad)} is not a mode and must be refused`);
  }
});

test('the CLI runs both profiles and still refuses a name that is not a profile', { timeout:60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(),'bench-cli-'));
  const out = join(dir,'report.json');
  try {
    const { stdout } = await run(process.execPath,[cli,'--profile','both','--out',out],{ encoding:'utf8', cwd:dir });
    const report = JSON.parse(readFileSync(out,'utf8'));
    assert.deepEqual(report.profiles.map(p => p.profile),['baseline','optimized'],'both ran in order, baseline first');
    assert.ok(report.comparison,'the two runs are compared');
    assert.match(stdout,/profile baseline:/);
    assert.match(stdout,/profile optimized:/);
    await assert.rejects(
      run(process.execPath,[cli,'--profile','fast'],{ encoding:'utf8', cwd:dir }),
      (error) => error.code !== 0 && /--profile: must be one of baseline, optimized, both/.test(String(error.stderr)),
      'a genuinely invalid profile name is still refused, before any run starts',
    );
  } finally { rmSync(dir,{ recursive:true, force:true }); }
});
