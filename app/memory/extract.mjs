// Rule-based extraction from real agent events. No model, no network, no summarizer.
//
// Each extractor reads one event shape and returns typed candidates carrying the
// provenance the store requires. Wording that cannot be classified stays unextracted
// rather than guessed: a missed memory is cheaper than a wrong one.
import { clip, sha256, tokens } from './text.mjs';

const REMEMBER_PATTERNS = [
  /(?:^|\s)(?:기억해|기억해줘|기억해 둬|기억해둬|기억해 주세요|메모해|메모해줘|저장해둬|저장해 둬)/,
  /\bremember (?:that|this)?\b/i,
  /\bnote (?:that|this)?\b/i,
  /\bkeep in mind\b/i,
];

const PREFERENCE_PATTERNS = [
  /(?:항상|언제나|매번|되도록|가능하면|선호|좋아|싫어|금지|하지 마|쓰지 마|사용하지 마|쓰지말|쓰지 말)/,
  /\b(?:always|never|prefer|don't use|do not use|avoid|instead of|use only)\b/i,
];

const RULE_PATTERNS = [
  /(?:반드시|필수|규칙|정책|관례|컨벤션|원칙)/,
  /\b(?:must|should|required|rule|policy|convention|by default)\b/i,
];

const DECISION_PATTERNS = [/(?:로 결정|로 변경|로 바꿨|로 교체|쓰기로|적용하기로)/, /\b(?:switched to|decided to|we now use|replaced with)\b/i];

const ERROR_FIX_PATTERNS = [/(?:오류|에러|실패|문제).*(?:해결|고쳤|고침|수정|대신|때문)/, /\b(?:error|failure|failed|bug)\b.*\b(?:fix|fixed|resolved|because|due to|instead)\b/i];

/** Strip the conversational wrapper so the stored text is the fact, not the request. */
function clean(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/(?:기억해\s*(?:줘|둬|두세요)?|메모해\s*(?:줘|둬)?|저장해\s*둬)\s*[.:：-]?\s*/g, '')
    .replace(/^\s*(?:remember|note|keep in mind)(?: that| this)?\s*[.:：-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyText(text) {
  const value = String(text ?? '');
  if (ERROR_FIX_PATTERNS.some((pattern) => pattern.test(value))) return 'error-fix';
  if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(value))) return 'user-preference';
  if (DECISION_PATTERNS.some((pattern) => pattern.test(value))) return 'project-rule';
  if (RULE_PATTERNS.some((pattern) => pattern.test(value))) return 'project-rule';
  return 'project-rule';
}

export function wantsRemember(prompt) {
  const value = String(prompt ?? '');
  return REMEMBER_PATTERNS.some((pattern) => pattern.test(value));
}

/** Explicit "remember this" in a user prompt. Trust tier: high (the user said it). */
export function explicitMemories({ prompt, sessionId, at = new Date().toISOString() }) {
  if (!wantsRemember(prompt)) return [];
  const statements = String(prompt)
    .split(/(?:\n|\.(?:\s|$)|;\s)/)
    .map(clean)
    .filter((line) => line.length >= 8)
    .slice(0, 3);
  return statements.map((statement) => ({
    type: classifyText(statement),
    title: clip(statement, 80),
    body: clip(statement, 320),
    importance: 0.85,
    sourceKind: 'user',
    sourceEvent: 'prompt:remember',
    sessionId,
    createdAt: at,
    explicit: true,
    tags: 'explicit',
  }));
}

/**
 * Preference / rule statements that were not marked "remember". They are real
 * standing instructions, but stated in passing, so they enter at medium importance.
 */
export function statedPreferences({ prompt, sessionId, at }) {
  if (wantsRemember(prompt)) return [];
  const statements = String(prompt)
    .split(/(?:\n|\.(?:\s|$))/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12 && line.length <= 220);
  return statements
    .filter((line) => PREFERENCE_PATTERNS.some((pattern) => pattern.test(line)))
    .slice(0, 2)
    .map((line) => ({
      type: 'user-preference',
      title: clip(line, 80),
      body: clip(line, 300),
      importance: 0.6,
      sourceKind: 'user',
      sourceEvent: 'prompt:preference',
      sessionId,
      createdAt: at,
      explicit: false,
    }));
}

/** Normalized error identity: the message and code, not the stack or the paths. */
export function errorSignature(toolName, result, args) {
  const text = resultText(result);
  const command = args?.command ?? args?.cmd ?? args?.file_path ?? args?.path ?? args?.pattern ?? '';
  const firstMeaningful =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /[A-Za-z가-힣]/.test(line) && !line.startsWith('at ') && line.length > 6) ?? '';
  const cleaned = firstMeaningful
    .replace(/[A-Za-z]:\\[^\s:]+/g, '<path>')
    .replace(/\/[^/\s]+(?:\/[^/\s]+)*/g, '<path>')
    .replace(/\b\d{1,4}\b/g, '<n>')
    .slice(0, 160);
  return {
    key: sha256(`${toolName}|${String(command).slice(0, 80)}|${cleaned}`).slice(0, 20),
    command: String(command).slice(0, 120),
    message: cleaned || clip(text, 120),
  };
}

export function resultText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n');
  }
  if (typeof result?.content === 'string') return result.content;
  if (typeof result?.stdout === 'string') return `${result.stdout}\n${result.stderr ?? ''}`;
  try {
    return JSON.stringify(result ?? '').slice(0, 400);
  } catch {
    return '';
  }
}

/** A failure that has no matching fix yet: worth remembering on its own. */
export function failureAnalysis({ toolName, result, args, sessionId, at }) {
  const signature = errorSignature(toolName, result, args);
  if (!signature.message) return null;
  return {
    type: 'failure-analysis',
    title: `${toolName} 실패: ${clip(signature.message, 70)}`,
    body: `도구 ${toolName} 실행이 실패했다. 명령/대상: ${signature.command || '(없음)'}. 오류: ${signature.message}`,
    importance: 0.5,
    sourceKind: 'tool',
    sourceEvent: 'tool_execution_end:error',
    sessionId,
    createdAt: at,
    errorKey: signature.key,
    tags: 'failure',
  };
}

/**
 * Error → fix pairing. The fix is only claimed when a *later* execution of the same
 * tool or command succeeded after the failure (the success is the evidence).
 */
export function errorFix({ failure, fix, sessionId, at }) {
  if (!failure || !fix) return null;
  return {
    type: 'error-fix',
    title: `고친 오류: ${clip(failure.message, 60)}`,
    body: `오류: ${failure.message} (도구 ${failure.tool}, 대상 ${failure.command || '(없음)'}). 해결: ${fix.command} 실행이 성공했다.`,
    importance: 0.8,
    sourceKind: 'tool',
    sourceEvent: 'tool_execution_end:fixed',
    sessionId,
    createdAt: at,
    errorKey: failure.key,
    tags: 'error-fix',
  };
}

const EXPLORE_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'list', 'code_graph']);

/** Reusable code-exploration finding: which tool found what, in which path. */
export function explorationFinding({ toolName, args, result, sessionId, at }) {
  if (!EXPLORE_TOOLS.has(toolName)) return null;
  const target = args?.file_path ?? args?.path ?? args?.pattern ?? args?.query ?? args?.symbols ?? '';
  const paths = (resultText(result).match(/[A-Za-z0-9_./\\-]+\.(?:mjs|js|ts|json|yml|py|md)\b/g) ?? [])
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 4);
  if (!path_ok(target, paths)) return null;
  return {
    type: 'exploration-finding',
    title: `${toolName}: ${clip(String(target), 60)}`,
    body: `${toolName}(${clip(String(target), 70)}) 결과에서 확인한 위치: ${paths.join(', ')}`,
    importance: 0.35,
    sourceKind: 'tool',
    sourceEvent: 'tool_execution_end:explore',
    sessionId,
    createdAt: at,
    subjectKey: `explore:${toolName}:${sha256(String(target)).slice(0, 12)}`,
    tags: 'exploration',
  };
}

function path_ok(target, paths) {
  return Boolean(target) && paths.length > 0;
}

/** Completion summary built from the tools a turn actually ran — no model narration. */
export function taskSummary({ sessionId, at, tools, files }) {
  if (!tools?.length && !files?.length) return null;
  const commands = tools.filter((tool) => tool.name === 'bash').map((tool) => clip(tool.args?.command ?? '', 90)).filter(Boolean);
  const edited = files?.slice(0, 6) ?? [];
  const parts = [];
  if (commands.length) parts.push(`실행: ${commands.slice(0, 3).join(' | ')}`);
  if (edited.length) parts.push(`수정: ${edited.join(', ')}`);
  if (!parts.length) return null;
  return {
    type: 'past-task',
    title: `작업: ${clip(commands[0] ?? edited[0] ?? '도구 실행', 70)}`,
    body: parts.join(' · '),
    importance: 0.45,
    sourceKind: 'tool',
    sourceEvent: 'agent_end:task',
    sessionId,
    createdAt: at,
    tags: 'task',
  };
}

export function keywordTags(text) {
  return tokens(text).slice(0, 8).join(' ');
}
