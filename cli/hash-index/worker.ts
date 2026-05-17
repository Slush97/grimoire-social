import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { extractArchive } from './extract';
import { USER_AGENT, type FileMeta } from './gamebanana';
import type { VpkHashRow } from './db';

export interface ProcessResult {
  vpks: VpkHashRow[];
  archive_md5: string;
}

export class IntegrityError extends Error {}

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: some archives are huge

async function stream_download_with_md5(
  url: string,
  dest_path: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`download HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    if (!res.body) throw new Error('empty response body');

    const md5 = createHash('md5');
    const out = createWriteStream(dest_path);

    // Convert the web stream to a Node Readable so we can pipeline it cleanly.
    // Tap each chunk into the hash on the way through.
    const src = Readable.fromWeb(res.body as never);
    src.on('data', (chunk: Buffer) => md5.update(chunk));

    await pipeline(src, out);
    return md5.digest('hex');
  } finally {
    clearTimeout(timer);
  }
}

async function sha256_file(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  const size = statSync(path).size;
  return { sha256: hash.digest('hex'), size };
}

/**
 * Download, verify, extract, hash. Caller is responsible for marking the row
 * `done`/`failed` in SQLite and cleaning up the tmp dir.
 */
export async function process_file(
  gb_mod_id: number,
  file: FileMeta,
  tmp_root: string,
): Promise<ProcessResult> {
  const work_dir = join(tmp_root, `f_${file.gb_file_id}`);
  await mkdir(work_dir, { recursive: true });

  // Preserve the original extension so extract.ts can pick the right unpacker.
  const archive_path = join(work_dir, basename(file.file_name));
  const extract_dir = join(work_dir, 'extracted');
  await mkdir(extract_dir, { recursive: true });

  try {
    const computed_md5 = await stream_download_with_md5(file.download_url, archive_path);

    if (file.archive_md5 && file.archive_md5.toLowerCase() !== computed_md5.toLowerCase()) {
      throw new IntegrityError(
        `md5 mismatch: expected ${file.archive_md5}, got ${computed_md5}`,
      );
    }

    const extracted_paths = await extractArchive(archive_path, extract_dir);

    // No VPKs inside this archive. Not an error per se (a sound pack might ship
    // loose .vsnd_c files), but we have nothing to hash. Caller marks `skipped`.
    if (extracted_paths.length === 0) {
      return { vpks: [], archive_md5: computed_md5 };
    }

    const vpks: VpkHashRow[] = [];
    for (const vpk_path of extracted_paths) {
      const { sha256, size } = await sha256_file(vpk_path);
      vpks.push({
        vpk_sha256: sha256,
        gb_file_id: file.gb_file_id,
        gb_mod_id,
        vpk_filename: basename(vpk_path),
        vpk_size: size,
      });
    }
    return { vpks, archive_md5: computed_md5 };
  } finally {
    // Best-effort cleanup. Don't let cleanup errors mask processing errors.
    try {
      await rm(work_dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
