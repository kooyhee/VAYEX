import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/**
 * Task Resume & Persistence Manager
 * Persists interrupted or in-progress vibe-coding tasks (request, plan, progress, changed files, snapshots)
 * and enables seamless restoration across restarts or connection interruptions.
 */
export class TaskResumeManager {
  /**
   * @param {object} options
   * @param {string} options.storageDir Directory where task states are saved.
   */
  constructor({ storageDir }) {
    this.storageDir = resolve(storageDir);
    this.memoryHook = null; // Can be wired to app/memory when mounted
  }

  async init() {
    await mkdir(this.storageDir, { recursive: true });
  }

  _taskFilePath(taskId) {
    const safeId = encodeURIComponent(taskId);
    return join(this.storageDir, `${safeId}.json`);
  }

  /**
   * Register memory module hook (provided by memory team).
   * @param {Function} hookFn
   */
  setMemoryHook(hookFn) {
    this.memoryHook = hookFn;
  }

  /**
   * Save or create a task state.
   *
   * @param {object} taskData
   * @param {string} taskData.taskId
   * @param {string} [taskData.sessionId]
   * @param {string} taskData.request - Korean user prompt
   * @param {Array} [taskData.plan] - Array of plan steps
   * @param {object} [taskData.progress] - { currentStep, totalSteps, percent }
   * @param {Array} [taskData.changedFiles] - List of affected file paths & status
   * @param {object} [taskData.verification] - Last verification result
   * @param {object} [taskData.memoryRef] - External session memory reference
   * @param {string} [taskData.status='running'] - 'running' | 'interrupted' | 'completed' | 'failed'
   * @returns {Promise<object>} The saved task state
   */
  async saveTaskState(taskData) {
    if (!taskData.taskId) {
      throw new Error('taskId는 필수 항목입니다.');
    }

    const now = Date.now();
    const existing = await this.getTaskState(taskData.taskId).catch(() => null);

    const merged = {
      taskId: taskData.taskId,
      sessionId: taskData.sessionId || existing?.sessionId || null,
      request: taskData.request || existing?.request || '',
      plan: taskData.plan || existing?.plan || [],
      progress: taskData.progress || existing?.progress || {
        currentStep: 0,
        totalSteps: (taskData.plan || existing?.plan || []).length,
        percent: 0
      },
      changedFiles: taskData.changedFiles || existing?.changedFiles || [],
      verification: taskData.verification || existing?.verification || null,
      memoryRef: {
        ...(existing?.memoryRef || {}),
        ...(taskData.memoryRef || {})
      },
      status: taskData.status || existing?.status || 'running',
      interruptReason: taskData.interruptReason || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    const filePath = this._taskFilePath(taskData.taskId);
    await writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');

    return merged;
  }

  /**
   * Retrieve a task state by taskId.
   *
   * @param {string} taskId
   * @returns {Promise<object>}
   */
  async getTaskState(taskId) {
    const filePath = this._taskFilePath(taskId);
    const data = await readFile(filePath, 'utf8');
    return JSON.parse(data);
  }

  /**
   * Update progress or specific fields of an existing task.
   *
   * @param {string} taskId
   * @param {object} updates
   * @returns {Promise<object>}
   */
  async updateTaskProgress(taskId, updates) {
    const current = await this.getTaskState(taskId);
    const updated = {
      ...current,
      ...updates,
      progress: {
        ...current.progress,
        ...(updates.progress || {})
      },
      updatedAt: Date.now()
    };

    const filePath = this._taskFilePath(taskId);
    await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  /**
   * Mark a task as interrupted with a Korean explanation.
   *
   * @param {string} taskId
   * @param {string} [reason='사용자 연결 끊김 또는 세션 중단']
   * @returns {Promise<object>}
   */
  async markInterrupted(taskId, reason = '사용자 연결 끊김 또는 세션 중단') {
    return this.updateTaskProgress(taskId, {
      status: 'interrupted',
      interruptReason: reason
    });
  }

  /**
   * List recent saved tasks, sorted by updatedAt descending.
   *
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {number} [filter.limit=20]
   * @returns {Promise<Array<object>>}
   */
  async listTasks(filter = {}) {
    const { status, limit = 20 } = filter;
    let files = [];
    try {
      files = await readdir(this.storageDir);
    } catch {
      return [];
    }

    const tasks = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.storageDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (!status || parsed.status === status) {
          tasks.push(parsed);
        }
      } catch {
        // Skip corrupted entries
      }
    }

    tasks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return tasks.slice(0, limit);
  }

  /**
   * Restores an interrupted task state, reconciling memory hook if registered.
   *
   * @param {string} taskId
   * @returns {Promise<{
   *   restored: boolean,
   *   task: object,
   *   memoryState: object|null,
   *   resumePrompt: string
   * }>}
   */
  async restoreTask(taskId) {
    const task = await this.getTaskState(taskId);

    if (!task) {
      throw new Error(`복원할 태스크를 찾을 수 없습니다: ${taskId}`);
    }

    let memoryState = null;
    if (this.memoryHook && typeof this.memoryHook === 'function') {
      try {
        memoryState = await this.memoryHook(task.memoryRef?.sessionKey || task.sessionId);
      } catch (err) {
        memoryState = { error: `메모리 복원 실패: ${err.message}` };
      }
    }

    // Generate plain Korean resume summary prompt for the student/vibe-coder
    const plan = task.plan || [];
    const completedSteps = plan.filter(s => s.status === 'completed').length;
    const totalSteps = plan.length;
    const nextStep = plan.find(s => s.status !== 'completed');
    const resumePrompt = `[중단된 작업 복원]
요청: "${task.request}"
진행 상황: 총 ${totalSteps}단계 중 ${completedSteps}단계 완료 (${task.progress?.percent || 0}%)
마지막 중단 사유: ${task.interruptReason || '이전 세션 보관됨'}
변경된 파일: ${task.changedFiles?.length || 0}개${nextStep ? `\n다음 단계: ${nextStep.title || nextStep.step}` : ''}
이어서 남은 작업을 계속 진행할 수 있습니다.`;

    // The persisted state becomes runnable again; that update is what the caller resumes.
    const updated = await this.updateTaskProgress(taskId, {
      status: 'running',
      interruptReason: null
    });

    return {
      restored: true,
      task: updated,
      memoryState,
      resumePrompt
    };
  }

  /**
   * Delete a task state.
   */
  async deleteTask(taskId) {
    const filePath = this._taskFilePath(taskId);
    try {
      await rm(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
