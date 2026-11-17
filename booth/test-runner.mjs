import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { detectProject } from '../app/dx/project-detect.mjs';
import { runVerification } from '../app/dx/auto-verify.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const sampleProjectDir = resolve(__dirname, 'sample-project');

async function testSampleProject() {
  console.log('--- 1. project-detect 검증 ---');
  const detection = await detectProject(sampleProjectDir);
  console.log('Detection 결과:', JSON.stringify(detection, null, 2));

  assert.equal(detection.detected, true, '프로젝트가 감지되어야 합니다.');
  assert.equal(detection.language, 'javascript', '언어가 javascript여야 합니다.');
  assert.equal(detection.packageManager, 'npm', '패키지 매니저가 npm이어야 합니다.');
  assert.equal(detection.testCommand, 'npm test', '테스트 명령어가 npm test여야 합니다.');
  assert.equal(detection.buildCommand, 'npm run build', '빌드 명령어가 npm run build여야 합니다.');

  console.log('\n--- 2. auto-verify (mode: auto -> testCommand) 검증 ---');
  const verifyTest = await runVerification({
    projectRoot: sampleProjectDir,
    mode: 'auto'
  });
  console.log('Verify (auto) 결과:', {
    success: verifyTest.success,
    status: verifyTest.status,
    command: verifyTest.command,
    durationMs: verifyTest.durationMs,
    summary: verifyTest.summary,
    stdout: verifyTest.stdout.trim()
  });

  assert.equal(verifyTest.success, true, '자동 검증(테스트)이 성공해야 합니다.');
  assert.equal(verifyTest.status, 'passed', '상태가 passed여야 합니다.');
  assert.equal(verifyTest.command, 'npm test', '실행 명령어가 npm test여야 합니다.');

  console.log('\n--- 3. auto-verify (mode: build) 검증 ---'
  );
  const verifyBuild = await runVerification({
    projectRoot: sampleProjectDir,
    mode: 'build'
  });
  console.log('Verify (build) 결과:', {
    success: verifyBuild.success,
    status: verifyBuild.status,
    command: verifyBuild.command,
    durationMs: verifyBuild.durationMs,
    summary: verifyBuild.summary,
    stdout: verifyBuild.stdout.trim()
  });

  assert.equal(verifyBuild.success, true, '빌드 검증이 성공해야 합니다.');
  assert.equal(verifyBuild.status, 'passed', '상태가 passed여야 합니다.');
  assert.equal(verifyBuild.command, 'npm run build', '실행 명령어가 npm run build여야 합니다.');

  console.log('\n--- 4. auto-verify 실패 감지(의도적 오류) 검증 ---');
  // 명시적 실패 명령어로 실패 감지 동작 확인
  const verifyFail = await runVerification({
    projectRoot: sampleProjectDir,
    command: 'node -e "throw new Error(\'SyntaxError: Unexpected token\')"'
  });
  console.log('Verify (fail) 결과:', {
    success: verifyFail.success,
    status: verifyFail.status,
    exitCode: verifyFail.exitCode,
    summary: verifyFail.summary,
    category: verifyFail.explanation?.category,
    cause: verifyFail.explanation?.cause
  });
  assert.equal(verifyFail.success, false, '오류 발생 시 success=false여야 합니다.');
  assert.equal(verifyFail.status, 'failed', '오류 발생 시 status=failed여야 합니다.');
  assert.equal(verifyFail.explanation?.category, 'syntax', '구문 오류로 분류되어야 합니다.');

  console.log('\n✓ [DX VERIFY OK] detection 및 auto-verify (성공 및 실패 감지) 모든 검증 완료');
}

testSampleProject().catch(err => {
  console.error('검증 중 오류 발생:', err);
  process.exit(1);
});
