// Trimmed copy of grimoire/electron/main/services/extract.ts for the
// hash-index scraper. Drops the asar-path shim (we never run inside an
// Electron asar here) and the install-time security helpers (one-click
// opt-out scan, suspicious-file scan, archive listing) that aren't needed
// when the only consumer is a hashing pipeline writing to a tmp dir.
//
// Extraction logic is unchanged from the original. If the upstream changes
// (new archive formats, new VPK filtering rules), mirror the change here.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  rmdirSync,
} from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { spawn } from 'node:child_process';
import { createExtractorFromData } from 'node-unrar-js';
import { path7za as bundled7zaPath } from '7zip-bin';

function find7zPath(): string[] {
  const candidates: string[] = [];
  if (existsSync(bundled7zaPath)) candidates.push(bundled7zaPath);
  for (const p of [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]) {
    if (existsSync(p)) candidates.push(p);
  }
  candidates.push('7z', '7za');
  return candidates;
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<string[]> {
  const ext = extname(archivePath).toLowerCase();
  switch (ext) {
    case '.zip':
      return extractZip(archivePath, destDir);
    case '.7z':
      return extract7z(archivePath, destDir);
    case '.rar':
      return extractRar(archivePath, destDir);
    default:
      throw new Error(`Unknown archive format: ${ext}`);
  }
}

function extractZip(archivePath: string, destDir: string): string[] {
  const zip = new AdmZip(archivePath);
  const extractedVpks: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const fileName = basename(entry.entryName);
    if (extname(fileName).toLowerCase() !== '.vpk') continue;
    const destPath = join(destDir, fileName);
    zip.extractEntryTo(entry, destDir, false, true);
    extractedVpks.push(destPath);
  }
  return extractedVpks;
}

async function extract7z(archivePath: string, destDir: string): Promise<string[]> {
  const tempDir = createTempDir('hashindex-7z');
  try {
    for (const tool of find7zPath()) {
      try {
        await runCommand(tool, ['x', '-y', `-o${tempDir}`, archivePath]);
        return copyVpksToDest(collectVpks(tempDir), destDir);
      } catch {
        // try next tool
      }
    }
    throw new Error(
      '7z extraction failed: bundled extractor failed and no system 7-Zip found.',
    );
  } finally {
    try {
      rmDirRecursive(tempDir);
    } catch {
      // ignore cleanup errors
    }
  }
}

async function extractRar(archivePath: string, destDir: string): Promise<string[]> {
  // Primary: pure-JS in-process extractor (no install required).
  try {
    const data = readFileSync(archivePath);
    const ab = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    const extractor = await createExtractorFromData({ data: ab });
    const extracted = extractor.extract({
      files: (header) =>
        !header.flags.directory && extname(header.name).toLowerCase() === '.vpk',
    });
    const extractedVpks: string[] = [];
    for (const file of extracted.files) {
      if (!file.extraction) continue;
      const fileName = basename(file.fileHeader.name);
      const destPath = join(destDir, fileName);
      writeFileSync(destPath, Buffer.from(file.extraction));
      extractedVpks.push(destPath);
    }
    if (extractedVpks.length > 0) return extractedVpks;
    // No VPKs via in-process: fall through in case it's a RAR5 solid archive
    // that node-unrar-js can't iterate but 7za/unrar can.
  } catch (err) {
    console.warn('[extractRar] node-unrar-js failed, trying system tools:', err);
  }

  const tempDir = createTempDir('hashindex-rar');
  try {
    for (const tool of [...find7zPath(), 'unrar']) {
      try {
        if (tool === 'unrar') {
          await runCommand(tool, ['x', '-y', archivePath, tempDir]);
        } else {
          await runCommand(tool, ['x', '-y', `-o${tempDir}`, archivePath]);
        }
        return copyVpksToDest(collectVpks(tempDir), destDir);
      } catch {
        // try next tool
      }
    }
    throw new Error('RAR extraction failed: no extractor could read this archive.');
  } finally {
    try {
      rmDirRecursive(tempDir);
    } catch {
      // ignore cleanup errors
    }
  }
}

function runCommand(cmd: string, args: string[], timeoutMs = 300000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' });
    let stderr = '';
    let killed = false;
    const timeoutId = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (killed) return;
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (code ${code}): ${stderr}`));
    });
    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      if (killed) return;
      reject(new Error(`${cmd} failed to run: ${err.message}`));
    });
  });
}

function collectVpks(dir: string): string[] {
  const vpks: string[] = [];
  function walk(currentDir: string): void {
    if (!existsSync(currentDir)) return;
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (extname(entry.name).toLowerCase() === '.vpk') vpks.push(fullPath);
    }
  }
  walk(dir);
  return vpks;
}

function copyVpksToDest(vpks: string[], destDir: string): string[] {
  const copied: string[] = [];
  for (const vpk of vpks) {
    const destPath = join(destDir, basename(vpk));
    copyFileSync(vpk, destPath);
    copied.push(destPath);
  }
  return copied;
}

function createTempDir(prefix: string): string {
  const suffix = randomBytes(16).toString('hex');
  const tmpDir = join(
    process.env.TMPDIR || process.env.TMP || '/tmp',
    `${prefix}-${suffix}`,
  );
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  return tmpDir;
}

function rmDirRecursive(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) rmDirRecursive(fullPath);
    else unlinkSync(fullPath);
  }
  rmdirSync(dir);
}
