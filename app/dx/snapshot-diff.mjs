import { readFile, writeFile, unlink, mkdir, rm, stat, readdir, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, isAbsolute } from 'node:path';

/** The task a read endpoint uses when the id was never recorded. Iterated, never written. */
const NO_TASK = new Map();

/**
 * Where `absPath` really is: every symlink and junction on the way resolved, with the
 * part that does not exist yet appended as written. Snapshotting a file the agent has not
 * created yet is the ordinary case, and `realpath` refuses a missing path, so the walk
 * stops at the deepest ancestor that does resolve.
 *
 * A purely lexical containment check is not enough on its own: `workspace/link/secret.txt`
 * reads as inside the tree while `link` is a junction to somewhere else, and every
 * read, restore and delete through it lands outside.
 *
 * @param {string} absPath
 * @returns {Promise<string|null>} the resolved path, or null when no ancestor resolves
 */
async function realPathOf(absPath) {
  const missing = [];
  let probe = absPath;
  for (;;) {
    try {
      const real = await realpath(probe);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      missing.push(basename(probe));
      probe = parent;
    }
  }
}

/**
 * A path that escapes the tree it is joined to. `code` is what the HTTP adapter maps to
 * a 400 instead of a 500, so a refusal reads as "this path is not yours to touch".
 */
function outsideRoot(what, value) {
  const error = new Error(`${what} 밖의 경로입니다: ${value}`);
  error.code = 'EOUTSIDEROOT';
  return error;
}

/**
 * Computes the Longest Common Subsequence of two arrays of strings.
 */
function computeLCS(linesA, linesB) {
  const m = linesA.length;
  const n = linesB.length;
  // If either array is very large (> 2000 lines), keep memory bounded
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (linesA[i] === linesB[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to build diff ops
  let i = m;
  let j = n;
  const ops = []; // { type: 'keep' | 'add' | 'del', line: string, aIdx: number, bIdx: number }

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.push({ type: 'keep', line: linesA[i - 1], aIdx: i - 1, bIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', line: linesB[j - 1], bIdx: j - 1 });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      ops.push({ type: 'del', line: linesA[i - 1], aIdx: i - 1 });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Generates unified diff string and hunk statistics from two text strings.
 *
 * @param {string|null} beforeText
 * @param {string|null} afterText
 * @param {string} filePath
 * @param {number} [contextLines=3]
 * @returns {{ diff: string, additions: number, deletions: number, hunks: object[] }}
 */
export function generateUnifiedDiff(beforeText, afterText, filePath = 'file', contextLines = 3) {
  const isNew = beforeText === null;
  const isDeleted = afterText === null;

  const normBefore = beforeText === null ? '' : beforeText.replace(/\r\n/g, '\n');
  const normAfter = afterText === null ? '' : afterText.replace(/\r\n/g, '\n');

  if (normBefore === normAfter) {
    return {
      diff: '',
      additions: 0,
      deletions: 0,
      hunks: []
    };
  }

  const linesA = beforeText === null || normBefore === '' ? [] : normBefore.split('\n');
  const linesB = afterText === null || normAfter === '' ? [] : normAfter.split('\n');

  const ops = computeLCS(linesA, linesB);

  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === 'add') additions++;
    else if (op.type === 'del') deletions++;
  }

  // Group diff ops into hunks with context
  const diffHunks = [];
  let currentHunk = null;

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    const isChange = op.type === 'add' || op.type === 'del';

    if (isChange) {
      if (!currentHunk) {
        // Start new hunk, grab leading context
        const contextStart = Math.max(0, idx - contextLines);
        const leadingContext = ops.slice(contextStart, idx);
        currentHunk = {
          startA: ops[contextStart]?.aIdx ?? (op.aIdx ?? 0),
          startB: ops[contextStart]?.bIdx ?? (op.bIdx ?? 0),
          lines: [...leadingContext]
        };
      }
      currentHunk.lines.push(op);
    } else if (currentHunk) {
      // It's a keep line after some change
      // Count upcoming changes within 2 * contextLines
      let nextChangeDist = -1;
      for (let next = idx; next < Math.min(ops.length, idx + contextLines * 2 + 1); next++) {
        if (ops[next].type !== 'keep') {
          nextChangeDist = next - idx;
          break;
        }
      }

      if (nextChangeDist !== -1) {
        // Keep within current hunk
        currentHunk.lines.push(op);
      } else {
        // Check trailing context
        const trailingLength = currentHunk.lines.filter(l => l.type === 'keep').length;
        const lastChangeIdx = currentHunk.lines.findLastIndex(l => l.type !== 'keep');
        const trailingKeeps = currentHunk.lines.length - 1 - lastChangeIdx;

        if (trailingKeeps < contextLines) {
          currentHunk.lines.push(op);
        } else {
          // Close hunk
          diffHunks.push(currentHunk);
          currentHunk = null;
        }
      }
    }
  }

  if (currentHunk) {
    diffHunks.push(currentHunk);
  }

  // Format hunks into unified diff text
  const header = `--- a/${filePath}${isNew ? ' (new file)' : ''}\n+++ b/${filePath}${isDeleted ? ' (deleted)' : ''}\n`;
  const formattedHunks = [];

  for (const hunk of diffHunks) {
    let countA = 0;
    let countB = 0;
    let startLineA = 1;
    let startLineB = 1;

    for (const line of hunk.lines) {
      if (line.type === 'del' || line.type === 'keep') {
        countA++;
        if (line.aIdx !== undefined && startLineA === 1 && countA === 1) {
          startLineA = line.aIdx + 1;
        }
      }
      if (line.type === 'add' || line.type === 'keep') {
        countB++;
        if (line.bIdx !== undefined && startLineB === 1 && countB === 1) {
          startLineB = line.bIdx + 1;
        }
      }
    }

    const hunkHeader = `@@ -${startLineA},${countA} +${startLineB},${countB} @@\n`;
    const hunkBody = hunk.lines.map(line => {
      if (line.type === 'add') return `+${line.line}`;
      if (line.type === 'del') return `-${line.line}`;
      return ` ${line.line}`;
    }).join('\n');

    formattedHunks.push(hunkHeader + hunkBody);
  }

  const diffText = formattedHunks.length > 0 ? header + formattedHunks.join('\n') : '';

  return {
    diff: diffText,
    additions,
    deletions,
    hunks: diffHunks
  };
}

/**
 * Snapshot & Recovery Manager
 * Stores pre-write file contents and manages revert/rollback per task.
 */
export class SnapshotManager {
  /**
   * @param {object} options
   * @param {string} options.storageDir Directory where snapshots are persisted.
   * @param {string} options.projectRoot Project root directory being edited.
   */
  constructor({ storageDir, projectRoot }) {
    this.storageDir = resolve(storageDir);
    this.projectRoot = resolve(projectRoot);
    // In-memory index of tasks: taskId -> Map(relativePath -> { exists, originalContent, status })
    this.tasks = new Map();
  }

  /**
   * Open the storage directory and rebuild the in-memory index from the manifests
   * written by `_persistEntry`. Snapshots outlive the process: without this, every
   * restart silently lost the pre-edit baseline and a revert had nothing to undo.
   */
  async init() {
    await mkdir(this.storageDir, { recursive: true });
    await this._loadManifests();
  }

  async _loadManifests() {
    let taskDirs;
    try {
      taskDirs = await readdir(this.storageDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of taskDirs) {
      if (!dirent.isDirectory()) continue;
      const taskId = dirent.name;
      const taskDir = join(this.storageDir, taskId);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(taskDir, 'manifest.json'), 'utf8'));
      } catch {
        // A task directory without a readable manifest holds no usable baseline.
        continue;
      }
      if (!manifest || typeof manifest.files !== 'object' || manifest.files === null) continue;

      const task = new Map();
      for (const [relPath, meta] of Object.entries(manifest.files)) {
        if (!meta || typeof meta !== 'object') continue;
        let originalContent = null;
        if (meta.exists) {
          try {
            originalContent = await readFile(join(taskDir, encodeURIComponent(relPath)), 'utf8');
          } catch {
            // The manifest says the file existed but its content snapshot is gone:
            // an empty baseline would revert the file to nothing, so skip it.
            continue;
          }
        }
        task.set(relPath, {
          relativePath: relPath,
          exists: meta.exists === true,
          originalContent,
          status: meta.status === 'reverted' ? 'reverted' : 'changed',
          timestamp: Number.isFinite(meta.timestamp) ? meta.timestamp : Date.now()
        });
      }
      if (task.size > 0) this.tasks.set(taskId, task);
    }
  }

  /**
   * The directory one task's snapshots live in. `taskId` arrives from a request body or
   * a query string, and `join(storageDir, '../../x')` wrote a manifest outside the store —
   * so an id that is empty, `..`, or carries a separator is refused instead of resolved.
   * @param {string} taskId
   * @returns {string}
   */
  _taskDir(taskId) {
    const id = typeof taskId === 'string' ? taskId : String(taskId ?? '');
    // A 5,000-character id is still "inside" the store, but Windows cannot create the
    // directory it names, so the request answered 500 with an ENOENT from `mkdir`. A
    // task id is a session id or a caller's own label; anything past this is not one.
    if (id.length > 200) throw outsideRoot('스냅샷 저장소', id.slice(0, 40) + '…');
    const dir = resolve(this.storageDir, id);
    const inside = relative(this.storageDir, dir);
    if (!id || !inside || inside.startsWith('..') || isAbsolute(inside)) throw outsideRoot('스냅샷 저장소', id);
    return dir;
  }

  /**
   * The task index to read, without opening one. `diff` and `revert` used to mint an
   * entry per distinct id they were shown, so a read endpoint the diff panel polls grew
   * this map for every id a caller invented and nothing ever removed the entries. The
   * id is still validated, so an id the store could not hold stays refused on reads too.
   * @param {string} taskId
   * @returns {Map<string, object>}
   */
  _taskFor(taskId) {
    const task = this.tasks.get(taskId);
    if (task) return task;
    this._taskDir(taskId);
    return NO_TASK;
  }

  /** The task index to write to, opened on first use. */
  _ensureTask(taskId) {
    if (!this.tasks.has(taskId)) {
      this._taskDir(taskId);
      this.tasks.set(taskId, new Map());
    }
    return this.tasks.get(taskId);
  }

  /**
   * Normalize path relative to projectRoot, refusing anything that resolves outside it.
   * An absolute path outside the root used to be kept verbatim — `resolve(projectRoot,
   * 'C:/…')` is that absolute path — so a request could snapshot, read and then revert any
   * file on the machine. A path outside the tree being edited is not a snapshot candidate:
   * the tool-start hook already skipped those, and this is the same rule for every caller.
   */
  _normalizePath(filePath) {
    const raw = String(filePath ?? '');
    const relPath = raw.startsWith(this.projectRoot)
      ? relative(this.projectRoot, raw).replace(/\\/g, '/')
      : raw.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    const inside = relative(this.projectRoot, resolve(this.projectRoot, relPath));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw outsideRoot('프로젝트 루트', raw);
    return relPath;
  }

  /** The root as the filesystem sees it, so containment survives a symlinked project root. */
  async _realRoot() {
    if (this._rootReal === undefined) {
      this._rootReal = await realpath(this.projectRoot).catch(() => this.projectRoot);
    }
    return this._rootReal;
  }

  /**
   * `_normalizePath` decided the path lexically. That is not where the file lands: a
   * symlink or NTFS junction inside the tree — `workspace/link` → anywhere — reads as
   * inside while `link/secret.txt` is a file outside it, so `record` cached that file's
   * content, `diff` served it, and `revert` rewrote or deleted it. The same path is
   * resolved through the real filesystem here, and a target that leaves the real root is
   * refused exactly as a lexical one is.
   * @param {string} relPath a path `_normalizePath` has accepted
   * @param {string} raw the caller's own value, for the refusal message
   * @returns {Promise<string>} relPath
   */
  async _contained(relPath, raw) {
    const realTarget = await realPathOf(resolve(this.projectRoot, relPath));
    const root = await this._realRoot();
    const inside = realTarget === null ? null : relative(root, realTarget);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw outsideRoot('프로젝트 루트', raw);
    return relPath;
  }

  /**
   * Record a snapshot of a file BEFORE the agent writes or modifies it.
   * If called multiple times for the same file in one task, preserves the FIRST original state.
   *
   * @param {string} taskId
   * @param {string} relativeOrAbsPath
   * @returns {Promise<{ relativePath: string, existed: boolean }>}
   */
  async recordSnapshot(taskId, relativeOrAbsPath) {
    const relPath = await this._contained(this._normalizePath(relativeOrAbsPath), relativeOrAbsPath);
    const task = this._ensureTask(taskId);

    if (task.has(relPath)) {
      // Already snapshotted earlier in this task; keep initial original baseline
      return { relativePath: relPath, existed: task.get(relPath).exists };
    }

    const absPath = resolve(this.projectRoot, relPath);
    let originalContent = null;
    let exists = false;

    try {
      const s = await stat(absPath);
      if (s.isFile()) {
        originalContent = await readFile(absPath, 'utf8');
        exists = true;
      }
    } catch {
      exists = false;
      originalContent = null;
    }

    const entry = {
      relativePath: relPath,
      exists,
      originalContent,
      status: 'changed', // 'changed' | 'reverted'
      timestamp: Date.now()
    };

    task.set(relPath, entry);

    // Persist snapshot to disk
    await this._persistEntry(taskId, entry);

    return { relativePath: relPath, existed: exists };
  }

  async _persistEntry(taskId, entry) {
    const taskDir = this._taskDir(taskId);
    await mkdir(taskDir, { recursive: true });
    const metaFile = join(taskDir, 'manifest.json');

    // Read or init manifest
    let manifest = {};
    try {
      manifest = JSON.parse(await readFile(metaFile, 'utf8'));
    } catch {
      manifest = { taskId, createdAt: Date.now(), files: {} };
    }

    manifest.files[entry.relativePath] = {
      exists: entry.exists,
      status: entry.status,
      timestamp: entry.timestamp
    };

    await writeFile(metaFile, JSON.stringify(manifest, null, 2), 'utf8');

    if (entry.exists && entry.originalContent !== null) {
      // Save content snapshot file
      const safeFilename = encodeURIComponent(entry.relativePath);
      await writeFile(join(taskDir, safeFilename), entry.originalContent, 'utf8');
    }
  }

  /**
   * Get preview diffs for all modified files in a task.
   *
   * @param {string} taskId
   * @returns {Promise<{
   *   taskId: string,
   *   files: Array<{
   *     path: string,
   *     status: string,
   *     fileType: 'modified' | 'created' | 'deleted' | 'identical',
   *     diff: string,
   *     additions: number,
   *     deletions: number,
   *     beforeContent: string|null,
   *     afterContent: string|null
   *   }>,
   *   summary: { totalFiles: number, totalAdditions: number, totalDeletions: number }
   * }>}
   */
  async getTaskDiff(taskId) {
    const task = this._taskFor(taskId);
    const files = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const [relPath, entry] of task.entries()) {
      const absPath = resolve(this.projectRoot, relPath);
      let currentContent = null;
      let currentExists = false;

      try {
        currentContent = await readFile(absPath, 'utf8');
        currentExists = true;
      } catch {
        currentExists = false;
        currentContent = null;
      }

      let fileType = 'modified';
      if (!entry.exists && currentExists) fileType = 'created';
      else if (entry.exists && !currentExists) fileType = 'deleted';
      else if (entry.originalContent === currentContent) fileType = 'identical';

      const diffResult = generateUnifiedDiff(entry.originalContent, currentContent, relPath);

      totalAdditions += diffResult.additions;
      totalDeletions += diffResult.deletions;

      files.push({
        path: relPath,
        status: entry.status,
        fileType,
        diff: diffResult.diff,
        additions: diffResult.additions,
        deletions: diffResult.deletions,
        beforeContent: entry.originalContent,
        afterContent: currentContent
      });
    }

    return {
      taskId,
      files,
      summary: {
        totalFiles: files.length,
        totalAdditions,
        totalDeletions
      }
    };
  }

  /**
   * Revert a single file back to its pre-write snapshot.
   *
   * @param {string} taskId
   * @param {string} relativeOrAbsPath
   * @returns {Promise<{ success: boolean, path: string, status: string, action: string }>}
   */
  async revertFile(taskId, relativeOrAbsPath) {
    const relPath = await this._contained(this._normalizePath(relativeOrAbsPath), relativeOrAbsPath);
    const task = this._taskFor(taskId);
    const entry = task.get(relPath);

    if (!entry) {
      // Nothing was recorded for this path in this task: a request for a snapshot that
      // does not exist, which is a 404 rather than the 500 a bare Error produced.
      const error = new Error(`스냅샷을 찾을 수 없습니다: ${relPath}`);
      error.code = 'ENOSNAPSHOT';
      throw error;
    }

    const absPath = resolve(this.projectRoot, relPath);

    let action = 'restored';
    if (!entry.exists) {
      // File was newly created by agent -> delete it
      try {
        await unlink(absPath);
        action = 'deleted';
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    } else {
      // Restore original content
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, entry.originalContent ?? '', 'utf8');
      action = 'restored';
    }

    entry.status = 'reverted';
    await this._persistEntry(taskId, entry);

    return { success: true, path: relPath, status: 'reverted', action };
  }

  /**
   * Rollback all files in the task to their initial snapshots.
   *
   * @param {string} taskId
   * @returns {Promise<{ revertedFiles: string[] }>}
   */
  async rollbackTask(taskId) {
    const task = this._taskFor(taskId);
    const revertedFiles = [];

    for (const relPath of task.keys()) {
      await this.revertFile(taskId, relPath);
      revertedFiles.push(relPath);
    }

    return { revertedFiles };
  }

  /**
   * Clean up snapshots for a completed task.
   */
  async cleanTask(taskId) {
    this.tasks.delete(taskId);
    const taskDir = this._taskDir(taskId);
    try {
      await rm(taskDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}
