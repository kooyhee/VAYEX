// SQLite storage for typed long-term memories.
//
// Extends the existing AST/FTS5 memory design found in `engine/memory_layer.py`:
// the same per-row `memories_fts` index, the same sanitized FTS5 MATCH (raised from
// `fts5_memory.py`), and the same "append-only, soft deprecation" discipline —
// rows are never deleted, only marked `superseded`, so history and provenance survive.
// Vectors are a plain `Float32Array` BLOB column: no native extension is required.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { memoryConfig, MEMORY_TYPES } from './config.mjs';
import { openDatabase } from './sqlite.mjs';
import {
  blobToFloat32,
  clip,
  cosine,
  fingerprintOf,
  float32ToBlob,
  jaccard,
  sanitizeFts5Query,
  shingles,
  tokens,
} from './text.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject_key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.4,
  trust TEXT NOT NULL DEFAULT 'medium',
  trust_score REAL NOT NULL DEFAULT 0.6,
  status TEXT NOT NULL DEFAULT 'active',
  injection_flag INTEGER NOT NULL DEFAULT 0,
  secrets_redacted INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT,
  superseded_by TEXT,
  fingerprint TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_event TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  dedupe_hits INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS memories_type_status ON memories(type, status);
CREATE INDEX IF NOT EXISTS memories_project ON memories(project, status);
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, model)
);
CREATE INDEX IF NOT EXISTS memory_vectors_model ON memory_vectors(model, dim);
CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  memory_id TEXT,
  session_id TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT);
`;

const DEDUPE_THRESHOLD = 0.72;

export class MemoryStore {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  static async open(overrides = {}) {
    const config = memoryConfig(overrides);
    mkdirSync(config.dataDir, { recursive: true });
    const db = await openDatabase(config.dbPath);
    const store = new MemoryStore(db, config);
    store.init();
    return store;
  }

  init() {
    this.db.exec(SCHEMA);
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, tags, tokenize='unicode61 remove_diacritics 2')",
    );
    return this;
  }

  get driver() {
    return this.db.driver;
  }

  now() {
    return new Date().toISOString();
  }

  // ---------------------------------------------------------------- writes

  /**
   * Store one screened candidate. Near-duplicates merge into the existing row,
   * and a newer value for the same subject supersedes the older one without
   * deleting it. Returns `{ id, action, merged }`.
   */
  add(candidate) {
    const type = MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'project-rule';
    const title = clip(candidate.title ?? '', 120);
    const body = clip(candidate.body ?? '', 480);
    if (!body) return { action: 'rejected', reason: 'empty body' };
    const project = candidate.project ?? this.config.project;
    const createdAt = candidate.createdAt ?? this.now();
    const record = {
      id: randomUUID(),
      type,
      subject_key: candidate.subjectKey ?? this.subjectKey(type, candidate),
      title: title || clip(body, 80),
      body,
      tags: tokens(`${title} ${body} ${candidate.tags ?? ''}`).slice(0, 40).join(' '),
      project,
      importance: Number(candidate.importance ?? 0.4),
      trust: candidate.trust ?? 'medium',
      trust_score: Number(candidate.trustScore ?? 0.6),
      status: candidate.injectionFlagged ? 'active' : 'active',
      injection_flag: candidate.injectionFlagged ? 1 : 0,
      secrets_redacted: candidate.secretsRedacted ? 1 : 0,
      fingerprint: fingerprintOf({ type, title, body }),
      session_id: candidate.sessionId,
      source_event: candidate.sourceEvent,
      source_kind: candidate.sourceKind ?? 'user',
      created_at: createdAt,
      updated_at: createdAt,
      last_seen_at: createdAt,
    };

    const duplicate = this.findDuplicate(record);
    if (duplicate) {
      const merged = this.merge(duplicate, record);
      return { id: merged.id, action: 'merged', merged: true };
    }

    const superseded = this.findSuperseded(record);
    for (const old of superseded) this.db.run('UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?', 'superseded', record.id, createdAt, old.id);
    if (superseded.length) record.supersedes = superseded.map((old) => old.id).join(',');
    if (superseded.length) {
      for (const old of superseded) this.audit('supersede', `newer ${record.id} replaced ${old.id}`, old.id, record.session_id);
    }

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO memories (id, type, subject_key, title, body, tags, project, importance, trust, trust_score,
           status, injection_flag, secrets_redacted, supersedes, superseded_by, fingerprint, session_id, source_event,
           source_kind, dedupe_hits, version, created_at, updated_at, last_seen_at, use_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,?,?,?,0)`,
        record.id, record.type, record.subject_key, record.title, record.body, record.tags, record.project,
        record.importance, record.trust, record.trust_score, record.status, record.injection_flag,
        record.secrets_redacted, record.supersedes ?? null, null, record.fingerprint, record.session_id,
        record.source_event, record.source_kind, record.created_at, record.updated_at, record.last_seen_at,
      );
      this.ftsInsert(record);
    });
    this.audit('insert', candidate.note ?? '', record.id, record.session_id, `${record.type}: ${record.title}`);
    return { id: record.id, action: 'inserted', superseded: superseded.map((old) => old.id) };
  }

  merge(existing, incoming) {
    const lengthier = incoming.body.length > existing.body.length ? incoming : existing;
    const importance = Math.max(existing.importance, incoming.importance) + 0.05;
    const merged = {
      ...existing,
      title: lengthier.title,
      body: lengthier.body,
      tags: incoming.tags,
      importance: Math.min(1, importance),
      trust: existing.trust_score >= incoming.trust_score ? existing.trust : incoming.trust,
      trust_score: Math.max(existing.trust_score, incoming.trust_score),
      updated_at: incoming.created_at,
      last_seen_at: incoming.created_at,
      version: existing.version + 1,
      dedupe_hits: existing.dedupe_hits + 1,
      fingerprint: fingerprintOf({ type: incoming.type, title: lengthier.title, body: lengthier.body }),
    };
    this.db.transaction(() => {
      this.db.run(
        `UPDATE memories SET title = ?, body = ?, tags = ?, importance = ?, trust = ?, trust_score = ?, updated_at = ?,
           last_seen_at = ?, version = ?, dedupe_hits = ?, fingerprint = ? WHERE id = ?`,
        merged.title, merged.body, merged.tags, merged.importance, merged.trust, merged.trust_score,
        merged.updated_at, merged.last_seen_at, merged.version, merged.dedupe_hits, merged.fingerprint, merged.id,
      );
      this.db.run('DELETE FROM memories_fts WHERE rowid = ?', existing.rid ?? this.rid(merged.id));
      this.ftsInsert({ ...merged, rid: this.rid(merged.id) });
    });
    // Re-embed the merged body: the stored vector described the shorter text.
    if (this.db.get('SELECT 1 AS x FROM memory_vectors WHERE memory_id = ?', merged.id)) {
      this.db.run('DELETE FROM memory_vectors WHERE memory_id = ?', merged.id);
    }
    this.audit('merge', `${incoming.session_id} re-stated ${merged.id}`, merged.id, incoming.session_id);
    return merged;
  }

  findDuplicate(record) {
    const candidates = this.db.all(
      "SELECT rowid AS rid, * FROM memories WHERE status = 'active' AND type = ? AND project = ? ORDER BY updated_at DESC LIMIT 200",
      record.type, record.project,
    );
    const incoming = shingles(`${record.title} ${record.body}`);
    let best = null;
    let bestScore = 0;
    for (const row of candidates) {
      if (row.fingerprint === record.fingerprint) return row;
      if (row.subject_key && record.subject_key && row.subject_key === record.subject_key) {
        const sameBody = jaccard(shingles(`${row.title} ${row.body}`), incoming);
        if (sameBody >= 0.5) return row;
        continue;
      }
      const score = jaccard(shingles(`${row.title} ${row.body}`), incoming);
      if (score >= DEDUPE_THRESHOLD && score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    return best;
  }

  findSuperseded(record) {
    if (!record.subject_key) return [];
    return this.db.all(
      "SELECT rowid AS rid, * FROM memories WHERE status = 'active' AND type = ? AND project = ? AND subject_key = ? AND fingerprint != ?",
      record.type, record.project, record.subject_key, record.fingerprint,
    );
  }

  subjectKey(type, candidate) {
    if (candidate.subjectKey) return candidate.subjectKey;
    if (type === 'error-fix' || type === 'failure-analysis') return candidate.errorKey ?? null;
    const head = tokens(candidate.title ?? candidate.body ?? '').slice(0, 6).join(' ');
    return head ? `${type}:${head}` : null;
  }

  ftsInsert(record) {
    this.db.run(
      'INSERT INTO memories_fts (rowid, title, body, tags) VALUES (?,?,?,?)',
      record.rid ?? this.rid(record.id), record.title, record.body, record.tags,
    );
  }

  rid(id) {
    const row = this.db.get('SELECT rowid AS rid FROM memories WHERE id = ?', id);
    return row?.rid ?? null;
  }

  // ---------------------------------------------------------------- reads

  get(id) {
    const row = this.db.get('SELECT rowid AS rid, * FROM memories WHERE id = ?', id);
    return row ? decorate(row) : null;
  }

  list({ type, status = 'active', project, query, limit = 50, offset = 0, includeSuperseded = false } = {}) {
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push('type = ?');
      params.push(type);
    }
    if (status && status !== 'any') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (project) {
      clauses.push('project = ?');
      params.push(project);
    }
    if (query) {
      clauses.push('(title LIKE ? OR body LIKE ?)');
      params.push(`%${query}%`, `%${query}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.all(
      `SELECT rowid AS rid, * FROM memories ${where} ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?`,
      ...params, Number(limit), Number(offset),
    );
    const out = rows.map(decorate);
    return includeSuperseded ? out : out.filter((row) => row.status !== 'deleted');
  }

  count({ type, status = 'active', project } = {}) {
    const clauses = [];
    const params = [];
    if (type) { clauses.push('type = ?'); params.push(type); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (project) { clauses.push('project = ?'); params.push(project); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.get(`SELECT COUNT(*) AS n FROM memories ${where}`, ...params)?.n ?? 0;
  }

  /** Active, non-quarantined rows the ranker is allowed to consider. */
  candidates({ project, limit = 2_000 } = {}) {
    const clauses = ["status = 'active'", 'injection_flag = 0'];
    const params = [];
    // Project scope is a filter, not a hint: a caller that names a project gets that
    // project's rows. Ranking still mixes an equal-scope 1.0 with a cross-project
    // 0.55 weight, but that weight only applies where a caller asked for no scope.
    if (project !== undefined) {
      clauses.push('project = ?');
      params.push(project);
    }
    return this.db.all(
      `SELECT rowid AS rid, * FROM memories WHERE ${clauses.join(' AND ')}
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      ...params, Number(limit),
    ).map(decorate);
  }

  /**
   * FTS5 BM25 keyword ranking. Returns `[{ id, score, rank }]`, rank 1 = best.
   * A named `project` restricts the ranking itself — scoping after the LIMIT would
   * rank another project's rows first and then throw them away, returning fewer hits
   * than the caller asked for.
   */
  keywordRank(query, { project, limit = 50 } = {}) {
    const match = sanitizeFts5Query(query);
    if (!match) return [];
    const scope = project === undefined ? '' : 'AND m.project = ?';
    const scopeParams = project === undefined ? [] : [project];
    let rows;
    try {
      rows = this.db.all(
        `SELECT m.id AS id, bm25(memories_fts) AS score FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.status = 'active' AND m.injection_flag = 0 ${scope}
          ORDER BY score LIMIT ?`,
        match, ...scopeParams, Number(limit),
      );
    } catch {
      // A token may still trip the FTS5 parser; the LIKE fallback keeps search alive.
      const terms = tokens(query).filter((term) => term.length > 1).slice(0, 8);
      if (!terms.length) return [];
      rows = this.db.all(
        `SELECT id, project, -1.0 AS score FROM memories
          WHERE status = 'active' AND injection_flag = 0 ${project === undefined ? '' : 'AND project = ?'}
            AND (${terms.map(() => 'body LIKE ?').join(' OR ')})
          LIMIT ?`,
        ...scopeParams, ...terms.map((term) => `%${term}%`), Number(limit),
      );
    }
    return rows.map((row, index) => ({ id: row.id, score: -Number(row.score), rank: index + 1 }));
  }

  vectors({ model, dim } = {}) {
    const clauses = [];
    const params = [];
    if (model) { clauses.push('model = ?'); params.push(model); }
    if (dim) { clauses.push('dim = ?'); params.push(Number(dim)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all(`SELECT memory_id, model, dim, vec FROM memory_vectors ${where}`, ...params)
      .map((row) => ({ memoryId: row.memory_id, model: row.model, dim: row.dim, vector: blobToFloat32(row.vec) }))
      .filter((row) => row.vector);
  }

  putVector(memoryId, model, vector) {
    this.db.run(
      `INSERT INTO memory_vectors (memory_id, model, dim, vec, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(memory_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at`,
      memoryId, model, vector.length, float32ToBlob(vector), this.now(),
    );
  }

  /** Memories that still have no vector for `model` — the lazy backfill worklist. */
  unembedded(model, limit = 200) {
    return this.db.all(
      `SELECT id FROM memories m WHERE m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = m.id AND v.model = ?)
        ORDER BY importance DESC LIMIT ?`,
      model, Number(limit),
    ).map((row) => row.id);
  }

  /** Record injected memories so recency/usage ranking reflects what was actually used. */
  recordUse(ids) {
    const at = this.now();
    for (const id of ids) {
      this.db.run('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', at, id);
    }
  }

  update(id, patch = {}) {
    const row = this.get(id);
    if (!row) return null;
    const next = {
      title: patch.title === undefined ? row.title : clip(patch.title, 120),
      body: patch.body === undefined ? row.body : clip(patch.body, 480),
      type: patch.type && MEMORY_TYPES.includes(patch.type) ? patch.type : row.type,
      importance: patch.importance === undefined ? row.importance : Number(patch.importance),
      project: patch.project ?? row.project,
    };
    const tags = tokens(`${next.title} ${next.body}`).slice(0, 40).join(' ');
    this.db.transaction(() => {
      this.db.run(
        `UPDATE memories SET title = ?, body = ?, type = ?, importance = ?, project = ?, tags = ?, fingerprint = ?,
           version = version + 1, updated_at = ?, status = 'active'
         WHERE id = ?`,
        next.title, next.body, next.type, next.importance, next.project, tags,
        fingerprintOf({ type: next.type, title: next.title, body: next.body }), this.now(), id,
      );
      this.db.run('DELETE FROM memories_fts WHERE rowid = ?', row.rowid);
      this.ftsInsert({ id, rid: row.rowid, title: next.title, body: next.body, tags });
      this.db.run('DELETE FROM memory_vectors WHERE memory_id = ?', id);
    });
    this.audit('edit', patch.note ?? 'manual edit', id, patch.sessionId ?? row.sessionId);
    return this.get(id);
  }

  /** Soft deprecation by default; `hard` is only for the explicit purge path. */
  remove(id, { hard = false, actor = 'api' } = {}) {
    const row = this.get(id);
    if (!row) return false;
    if (hard) {
      this.db.transaction(() => {
        this.db.run('DELETE FROM memories_fts WHERE rowid = ?', row.rowid);
        this.db.run('DELETE FROM memory_vectors WHERE memory_id = ?', id);
        this.db.run('DELETE FROM memories WHERE id = ?', id);
      });
    } else {
      this.db.run("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?", this.now(), id);
    }
    this.audit(hard ? 'purge' : 'delete', actor, id, row.sessionId);
    return true;
  }

  audit(action, reason, memoryId = null, sessionId = null, detail = null) {
    const at = this.now();
    this.db.run('INSERT INTO memory_audit (at, action, reason, memory_id, session_id, detail) VALUES (?,?,?,?,?,?)',
      at, action, reason ?? null, memoryId, sessionId, detail);
    try {
      appendFileSync(
        this.config.auditPath,
        `${JSON.stringify({ at, action, reason, memoryId, sessionId, detail })}\n`,
      );
    } catch {}
  }

  auditLog(limit = 100) {
    return this.db.all('SELECT * FROM memory_audit ORDER BY id DESC LIMIT ?', Number(limit)).map((row) => ({
      at: row.at, action: row.action, reason: row.reason, memoryId: row.memory_id, sessionId: row.session_id, detail: row.detail,
    }));
  }

  stats() {
    const totals = this.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded,
              SUM(CASE WHEN injection_flag = 1 THEN 1 ELSE 0 END) AS quarantined,
              SUM(CASE WHEN secrets_redacted = 1 THEN 1 ELSE 0 END) AS redacted
         FROM memories`,
    ) ?? {};
    const byType = this.db.all("SELECT type, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY type");
    const vectorRows = this.db.all('SELECT model, dim, COUNT(*) AS n FROM memory_vectors GROUP BY model, dim');
    return {
      driver: this.db.driver,
      total: Number(totals.total ?? 0),
      active: Number(totals.active ?? 0),
      superseded: Number(totals.superseded ?? 0),
      quarantined: Number(totals.quarantined ?? 0),
      redacted: Number(totals.redacted ?? 0),
      byType: Object.fromEntries(byType.map((row) => [row.type, Number(row.n)])),
      vectors: vectorRows.map((row) => ({ model: row.model, dim: row.dim, count: Number(row.n) })),
      fts: true,
      project: this.config.project,
      dbPath: this.config.dbPath,
    };
  }

  cosineRank(queryVector, { model, project, limit = 50 } = {}) {
    const rows = this.vectors({ model, dim: queryVector.length });
    const scored = rows.map((row) => ({ id: row.memoryId, score: cosine(queryVector, row.vector) }));
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  close() {
    this.db.close();
  }
}

function decorate(row) {
  return {
    rowid: row.rid ?? null,
    id: row.id,
    type: row.type,
    subjectKey: row.subject_key,
    title: row.title,
    body: row.body,
    tags: row.tags,
    project: row.project,
    importance: Number(row.importance),
    trust: row.trust,
    trustScore: Number(row.trust_score),
    status: row.status,
    injectionFlag: Number(row.injection_flag) === 1,
    secretsRedacted: Number(row.secrets_redacted) === 1,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    fingerprint: row.fingerprint,
    sessionId: row.session_id,
    sourceEvent: row.source_event,
    sourceKind: row.source_kind,
    dedupeHits: Number(row.dedupe_hits),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at,
  };
}

export function memoryPathLabel(config) {
  return path.relative(config.root, config.dbPath);
}
