/**
 * Student / Vibe-Coder Convenience Backend (app/dx)
 *
 * Core capabilities:
 * 1. Project auto-detection (language, framework, PM, build/test commands)
 * 2. Change preview & recovery (Git-free snapshots, unified diffs, revert, rollback)
 * 3. Auto-verify runner (process execution with timeout, bounding, and summary)
 * 4. Plain Korean error explainer (rule-based classification, cause + suggested fix)
 * 5. Task resume & persistence (request, plan, progress, snapshots, memory hooks)
 * 6. Cost visualization data (spend & optimization aggregation, KRW/USD, vibe summaries)
 * 7. HTTP Route handler module for mounting in app/server.mjs
 */

export { detectProject } from './project-detect.mjs';
export { SnapshotManager, generateUnifiedDiff } from './snapshot-diff.mjs';
export { runVerification } from './auto-verify.mjs';
export { explainError } from './korean-error-explainer.mjs';
export { TaskResumeManager } from './task-resume.mjs';
export { CostAnalytics } from './cost-analytics.mjs';
export { createDxRouter, fileModifyingPaths, toolStartPaths } from './routes.mjs';
