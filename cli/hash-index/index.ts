#!/usr/bin/env tsx
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, prepareStatements, type DiscoveredFile, type Statements } from './db';
import {
  list_page,
  get_files,
  SECTIONS,
  type Section,
} from './gamebanana';
import { process_file, IntegrityError } from './worker';

interface Args {
  max_pages: number | null;
  sections: Section[];
  limit: number | null;
  discovery_only: boolean;
  process_only: boolean;
}

function parse_args(argv: string[]): Args {
  const args: Args = {
    max_pages: null,
    sections: [...SECTIONS],
    limit: null,
    discovery_only: false,
    process_only: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-pages') args.max_pages = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--sections') {
      args.sections = argv[++i].split(',').map((s) => s.trim() as Section);
    } else if (a === '--discovery-only') args.discovery_only = true;
    else if (a === '--process-only') args.process_only = true;
  }
  return args;
}

const here = fileURLToPath(new URL('.', import.meta.url));
const data_dir = resolve(here, 'data');
const db_path = resolve(data_dir, 'hash-index.db');
const tmp_root = resolve(data_dir, 'tmp');

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) {
    console.error('\n[!] second SIGINT, hard exit');
    process.exit(130);
  }
  interrupted = true;
  console.error('\n[!] SIGINT received, finishing current file then stopping...');
});

interface RunStats {
  started_at: number;
  finished_at: number | null;
  discovered: number;
  processed: number;
  reused_via_md5: number;
  skipped_no_vpks: number;
  failed: number;
  bytes_downloaded: number;
  vpks_hashed: number;
}

async function run_discovery(
  stmts: Statements,
  sections: Section[],
  max_pages: number | null,
  stats: RunStats,
): Promise<void> {
  for (const section of sections) {
    if (interrupted) return;
    console.log(`\n=== discovery: ${section} ===`);
    let page = 1;
    while (true) {
      if (interrupted) return;
      const list = await list_page(section, page);
      const candidate_mods = list.records.filter((r) => r.has_files);
      console.log(
        `  page ${page}: ${list.records.length} mods (${candidate_mods.length} with files)`,
      );

      const batch: DiscoveredFile[] = [];
      for (const m of candidate_mods) {
        if (interrupted) break;
        try {
          const files = await get_files(section, m.gb_mod_id);
          for (const f of files) {
            batch.push({
              gb_file_id: f.gb_file_id,
              gb_mod_id: m.gb_mod_id,
              gb_section: section,
              file_name: f.file_name,
              file_size: f.file_size,
              archive_md5: f.archive_md5,
              download_url: f.download_url,
              date_added: f.date_added || m.date_modified,
            });
          }
        } catch (err) {
          console.warn(`    skip mod ${m.gb_mod_id}: ${(err as Error).message}`);
        }
      }
      const inserted = stmts.insertFiles(batch);
      stats.discovered += inserted;
      console.log(`    inserted ${inserted} new file rows (batch ${batch.length})`);

      stmts.upsertCheckpoint(section, page, Math.floor(Date.now() / 1000));

      if (list.is_complete) break;
      page++;
      if (max_pages && page > max_pages) {
        console.log(`  stopping at --max-pages ${max_pages}`);
        break;
      }
    }
  }
}

async function run_processing(
  stmts: Statements,
  limit: number | null,
  stats: RunStats,
): Promise<void> {
  await mkdir(tmp_root, { recursive: true });
  const pending = stmts.listPending();
  const target = limit ? pending.slice(0, limit) : pending;
  console.log(`\n=== processing: ${target.length} pending file(s) ===`);

  let i = 0;
  for (const row of target) {
    if (interrupted) break;
    i++;
    const tag = `[${i}/${target.length}] file ${row.gb_file_id} (${row.gb_section}, ${row.file_name})`;

    // Resumability shortcut: if another `done` row has the same archive_md5,
    // copy its vpk_hashes without re-downloading.
    if (row.archive_md5) {
      const twin = stmts.findDoneByMd5(row.archive_md5);
      if (twin) {
        const twin_vpks = stmts.getVpksForFile(twin.gb_file_id);
        const copied = twin_vpks.map((v) => ({
          ...v,
          gb_file_id: row.gb_file_id,
          gb_mod_id: row.gb_mod_id,
        }));
        stmts.recordSuccess(row.gb_file_id, copied);
        stats.reused_via_md5++;
        stats.vpks_hashed += copied.length;
        console.log(`${tag}: REUSED md5 match (${copied.length} vpks copied)`);
        continue;
      }
    }

    try {
      const result = await process_file(
        row.gb_mod_id,
        {
          gb_file_id: row.gb_file_id,
          file_name: row.file_name,
          file_size: row.file_size,
          archive_md5: row.archive_md5,
          download_url: row.download_url,
          date_added: row.date_added,
        },
        tmp_root,
      );
      stats.bytes_downloaded += row.file_size;
      if (result.vpks.length === 0) {
        stmts.recordSkipped('no vpks in archive', Math.floor(Date.now() / 1000), row.gb_file_id);
        stats.skipped_no_vpks++;
        console.log(`${tag}: SKIPPED (no vpks)`);
      } else {
        stmts.recordSuccess(row.gb_file_id, result.vpks);
        stats.processed++;
        stats.vpks_hashed += result.vpks.length;
        console.log(`${tag}: OK (${result.vpks.length} vpks)`);
      }
    } catch (err) {
      const msg = err instanceof IntegrityError
        ? `integrity: ${err.message}`
        : (err as Error).message;
      stmts.recordFailure(msg, Math.floor(Date.now() / 1000), row.gb_file_id);
      stats.failed++;
      console.warn(`${tag}: FAIL ${msg}`);
    }
  }
}

function print_summary(stmts: Statements, stats: RunStats): void {
  const rows = stmts.stats();
  console.log('\n=== summary ===');
  console.log(`elapsed: ${((stats.finished_at! - stats.started_at) / 1000).toFixed(1)}s`);
  console.log(`discovered (new): ${stats.discovered}`);
  console.log(`processed:        ${stats.processed}`);
  console.log(`reused via md5:   ${stats.reused_via_md5}`);
  console.log(`skipped no vpks:  ${stats.skipped_no_vpks}`);
  console.log(`failed:           ${stats.failed}`);
  console.log(`vpks hashed:      ${stats.vpks_hashed}`);
  console.log(`bytes downloaded: ${(stats.bytes_downloaded / 1024 / 1024).toFixed(1)} MiB`);
  console.log('\nfile statuses in db:');
  for (const r of rows) console.log(`  ${r.status.padEnd(8)} ${r.n}`);
}

async function main(): Promise<void> {
  const args = parse_args(process.argv.slice(2));
  console.log('hash-index Phase 0 prototype');
  console.log('args:', args);

  await mkdir(data_dir, { recursive: true });
  const db = openDb(db_path);
  const stmts = prepareStatements(db);

  const stats: RunStats = {
    started_at: Date.now(),
    finished_at: null,
    discovered: 0,
    processed: 0,
    reused_via_md5: 0,
    skipped_no_vpks: 0,
    failed: 0,
    bytes_downloaded: 0,
    vpks_hashed: 0,
  };

  try {
    if (!args.process_only) {
      await run_discovery(stmts, args.sections, args.max_pages, stats);
    }
    if (!args.discovery_only) {
      await run_processing(stmts, args.limit, stats);
    }
  } finally {
    stats.finished_at = Date.now();
    print_summary(stmts, stats);
    await writeFile(
      resolve(data_dir, `stats-${stats.started_at}.json`),
      JSON.stringify(stats, null, 2),
    );
    db.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
