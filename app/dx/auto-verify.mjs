import { spawn } from 'node:child_process';
import { detectProject } from './project-detect.mjs';
import { explainError } from './korean-error-explainer.mjs';

/**
 * Strips ANSI color and control codes from terminal output.
 */
function stripAnsi(str) {
  return (str || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Runs a shell command with a hard timeout and captures outputs safely.
 *
 * @param {string} commandLine
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {object} extraEnv
 * @returns {Promise<{
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number|null,
 *   signal: string|null,
 *   durationMs: number,
 *   timedOut: boolean
 * }>}
 */
function executeCommand(commandLine, cwd, timeoutMs = 30000, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const startTime = Date.now();
    let timedOut = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const MAX_OUTPUT = 65536; // 64KB limit

    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', commandLine] : ['-c', commandLine];

    const child = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...extraEnv }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) {
          // On Windows, taskkill is needed to kill process tree
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill();
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBuffer.length < MAX_OUTPUT) {
        stdoutBuffer += chunk.toString('utf8');
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBuffer.length < MAX_OUTPUT) {
        stderrBuffer += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolvePromise({
        stdout: stripAnsi(stdoutBuffer),
        stderr: stripAnsi(stderrBuffer + '\n' + err.message),
        exitCode: 1,
        signal: null,
        durationMs,
        timedOut: false
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolvePromise({
        stdout: stripAnsi(stdoutBuffer),
        stderr: stripAnsi(stderrBuffer),
        exitCode: code,
        signal,
        durationMs,
        timedOut
      });
    });
  });
}

/**
 * Automatically detects and executes relevant test or build verification for a project.
 *
 * @param {object} options
 * @param {string} options.projectRoot - Root directory of the project to verify
 * @param {string} [options.command] - Optional explicit command to run
 * @param {'test'|'build'|'auto'} [options.mode='auto'] - Verification mode
 * @param {number} [options.timeoutMs=30000] - Hard execution deadline in ms
 * @param {object} [options.env={}] - Additional environment variables
 * @returns {Promise<{
 *   success: boolean,
 *   status: 'passed' | 'failed' | 'timeout' | 'skipped',
 *   command: string|null,
 *   durationMs: number,
 *   exitCode: number|null,
 *   timedOut: boolean,
 *   summary: string,
 *   explanation: object|null,
 *   stdout: string,
 *   stderr: string
 * }>}
 */
export async function runVerification(options) {
  const {
    projectRoot,
    command: explicitCommand,
    mode = 'auto',
    timeoutMs = 30000,
    env = {}
  } = options;

  let chosenCommand = explicitCommand || null;
  let detection = null;

  if (!chosenCommand) {
    detection = await detectProject(projectRoot);
    if (mode === 'build') {
      chosenCommand = detection.buildCommand;
    } else if (mode === 'test') {
      chosenCommand = detection.testCommand;
    } else {
      // 'auto': prioritize test, fallback to build
      chosenCommand = detection.testCommand || detection.buildCommand;
    }
  }

  if (!chosenCommand) {
    return {
      success: true,
      status: 'skipped',
      command: null,
      durationMs: 0,
      exitCode: 0,
      timedOut: false,
      summary: '감지된 테스트 또는 빌드 명령어가 없어 자동 검증을 건너뛰었습니다.',
      explanation: null,
      stdout: '',
      stderr: ''
    };
  }

  const result = await executeCommand(chosenCommand, projectRoot, timeoutMs, env);

  const durationSec = (result.durationMs / 1000).toFixed(2);

  if (result.timedOut) {
    const explanation = explainError(`Process timed out after ${timeoutMs}ms\n${result.stderr}\n${result.stdout}`);
    return {
      success: false,
      status: 'timeout',
      command: chosenCommand,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: true,
      summary: `검증 실패: ${timeoutMs / 1000}초 제한 시간을 초과했습니다. (${explanation.cause})`,
      explanation,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  if (result.exitCode === 0) {
    const isTest = chosenCommand.includes('test');
    return {
      success: true,
      status: 'passed',
      command: chosenCommand,
      durationMs: result.durationMs,
      exitCode: 0,
      timedOut: false,
      summary: `검증 통과: ${isTest ? '모든 테스트' : '빌드'}를 성공적으로 완료했습니다. (${durationSec}초 소요)`,
      explanation: null,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  // Failure
  const errorCombined = (result.stderr || '') + '\n' + (result.stdout || '');
  const explanation = explainError(errorCombined);

  return {
    success: false,
    status: 'failed',
    command: chosenCommand,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: false,
    summary: `검증 실패: ${explanation.cause} (종료 코드 ${result.exitCode}, ${durationSec}초 소요)`,
    explanation,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
