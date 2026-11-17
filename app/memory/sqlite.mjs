// Thin SQLite adapter: `node:sqlite` under Node (the host bridge) and `bun:sqlite`
// under Bun (the `omp` child that runs the extension). Both ship FTS5 in this
// repository's runtimes (verified: node 26.13.0 / sqlite 3.54.0 and bun 1.4.4).
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const isBun = typeof globalThis.Bun !== 'undefined';

export const sqliteDriver = isBun ? 'bun:sqlite' : 'node:sqlite';

export async function openDatabase(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (isBun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(filePath, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    return wrap(db);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return wrap(db);
}

function wrap(db) {
  return {
    driver: sqliteDriver,
    exec(sql) {
      db.exec(sql);
    },
    run(sql, ...params) {
      return db.prepare(sql).run(...params);
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params) ?? null;
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params) ?? [];
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    },
    close() {
      db.close();
    },
    raw: db,
  };
}
