import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileRow {
  gb_file_id: number;
  gb_mod_id: number;
  gb_section: string;
  file_name: string;
  file_size: number;
  archive_md5: string | null;
  download_url: string;
  date_added: number;
  status: 'pending' | 'done' | 'failed' | 'skipped';
  error: string | null;
  processed_at: number | null;
}

export interface VpkHashRow {
  vpk_sha256: string;
  gb_file_id: number;
  gb_mod_id: number;
  vpk_filename: string;
  vpk_size: number;
}

export interface DiscoveredFile {
  gb_file_id: number;
  gb_mod_id: number;
  gb_section: string;
  file_name: string;
  file_size: number;
  archive_md5: string | null;
  download_url: string;
  date_added: number;
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
    PRAGMA temp_store = MEMORY;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      gb_file_id    INTEGER PRIMARY KEY,
      gb_mod_id     INTEGER NOT NULL,
      gb_section    TEXT NOT NULL,
      file_name     TEXT NOT NULL,
      file_size     INTEGER NOT NULL,
      archive_md5   TEXT,
      download_url  TEXT NOT NULL,
      date_added    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      processed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_md5    ON files(archive_md5);
    CREATE INDEX IF NOT EXISTS idx_files_mod    ON files(gb_mod_id);

    CREATE TABLE IF NOT EXISTS vpk_hashes (
      vpk_sha256    TEXT NOT NULL,
      gb_file_id    INTEGER NOT NULL,
      gb_mod_id     INTEGER NOT NULL,
      vpk_filename  TEXT NOT NULL,
      vpk_size      INTEGER NOT NULL,
      PRIMARY KEY (vpk_sha256, gb_file_id, vpk_filename),
      FOREIGN KEY (gb_file_id) REFERENCES files(gb_file_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vpk_by_file ON vpk_hashes(gb_file_id);
    CREATE INDEX IF NOT EXISTS idx_vpk_by_mod  ON vpk_hashes(gb_mod_id);

    CREATE TABLE IF NOT EXISTS scrape_checkpoints (
      section            TEXT PRIMARY KEY,
      last_page          INTEGER NOT NULL DEFAULT 0,
      last_discovered_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

// node:sqlite has no built-in db.transaction(fn) wrapper, so roll our own.
// Commits on return, rolls back on throw.
function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function prepareStatements(db: DatabaseSync) {
  // INSERT OR IGNORE so re-discovery of the same file id doesn't reset
  // a `done` row's status back to `pending`. archive_md5 is set on first
  // discovery and stays; if GameBanana ever updates the hash for a file,
  // we'd need an explicit refresh path (not in Phase 0).
  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO files
      (gb_file_id, gb_mod_id, gb_section, file_name, file_size,
       archive_md5, download_url, date_added, status)
    VALUES
      (:gb_file_id, :gb_mod_id, :gb_section, :file_name, :file_size,
       :archive_md5, :download_url, :date_added, 'pending')
  `);

  const insertVpk = db.prepare(`
    INSERT OR REPLACE INTO vpk_hashes
      (vpk_sha256, gb_file_id, gb_mod_id, vpk_filename, vpk_size)
    VALUES
      (:vpk_sha256, :gb_file_id, :gb_mod_id, :vpk_filename, :vpk_size)
  `);

  const markDone = db.prepare(
    `UPDATE files SET status = 'done', error = NULL, processed_at = :ts WHERE gb_file_id = :gb_file_id`,
  );

  const recordFailure = db.prepare(
    `UPDATE files SET status = 'failed', error = :error, processed_at = :ts WHERE gb_file_id = :gb_file_id`,
  );

  const recordSkipped = db.prepare(
    `UPDATE files SET status = 'skipped', error = :error, processed_at = :ts WHERE gb_file_id = :gb_file_id`,
  );

  const findDoneByMd5 = db.prepare(
    `SELECT gb_file_id FROM files
       WHERE archive_md5 = :archive_md5 AND status = 'done'
       LIMIT 1`,
  );

  const getVpksForFile = db.prepare(
    `SELECT vpk_sha256, gb_file_id, gb_mod_id, vpk_filename, vpk_size
       FROM vpk_hashes WHERE gb_file_id = :gb_file_id`,
  );

  const listPending = db.prepare(
    `SELECT gb_file_id, gb_mod_id, gb_section, file_name, file_size,
            archive_md5, download_url, date_added, status, error, processed_at
       FROM files WHERE status = 'pending' ORDER BY date_added DESC`,
  );

  const upsertCheckpoint = db.prepare(
    `INSERT INTO scrape_checkpoints (section, last_page, last_discovered_at)
     VALUES (:section, :last_page, :last_discovered_at)
     ON CONFLICT(section) DO UPDATE SET
       last_page = excluded.last_page,
       last_discovered_at = excluded.last_discovered_at`,
  );

  const statsQ = db.prepare(`SELECT status, COUNT(*) AS n FROM files GROUP BY status`);

  function insertFiles(rows: DiscoveredFile[]): number {
    return transact(db, () => {
      let inserted = 0;
      for (const r of rows) {
        const info = insertFile.run({
          gb_file_id: r.gb_file_id,
          gb_mod_id: r.gb_mod_id,
          gb_section: r.gb_section,
          file_name: r.file_name,
          file_size: r.file_size,
          archive_md5: r.archive_md5,
          download_url: r.download_url,
          date_added: r.date_added,
        });
        if (info.changes && Number(info.changes) > 0) inserted++;
      }
      return inserted;
    });
  }

  function recordSuccess(gb_file_id: number, vpks: VpkHashRow[]): void {
    transact(db, () => {
      for (const v of vpks) {
        insertVpk.run({
          vpk_sha256: v.vpk_sha256,
          gb_file_id: v.gb_file_id,
          gb_mod_id: v.gb_mod_id,
          vpk_filename: v.vpk_filename,
          vpk_size: v.vpk_size,
        });
      }
      markDone.run({ ts: Math.floor(Date.now() / 1000), gb_file_id });
    });
  }

  return {
    insertFiles,
    recordSuccess,
    recordFailure: (error: string, ts: number, gb_file_id: number) =>
      recordFailure.run({ error, ts, gb_file_id }),
    recordSkipped: (error: string, ts: number, gb_file_id: number) =>
      recordSkipped.run({ error, ts, gb_file_id }),
    findDoneByMd5: (archive_md5: string) =>
      findDoneByMd5.get({ archive_md5 }) as { gb_file_id: number } | undefined,
    getVpksForFile: (gb_file_id: number) =>
      getVpksForFile.all({ gb_file_id }) as unknown as VpkHashRow[],
    listPending: () => listPending.all() as unknown as FileRow[],
    upsertCheckpoint: (section: string, last_page: number, last_discovered_at: number) =>
      upsertCheckpoint.run({ section, last_page, last_discovered_at }),
    stats: () => statsQ.all() as unknown as { status: string; n: number }[],
  };
}

export type Statements = ReturnType<typeof prepareStatements>;
// Re-export so consumers don't need their own node:sqlite import.
export type { StatementSync };
