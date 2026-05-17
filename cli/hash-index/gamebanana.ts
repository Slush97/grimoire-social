const GB_BASE = 'https://gamebanana.com/apiv11';
const DEADLOCK_GAME_ID = 20948;

export const USER_AGENT =
  'Grimoire-HashIndex/0.1 (+https://github.com/Slush97/grimoire; contact: slusheliott@gmail.com)';

// Sections we care about. GameBanana exposes both as separate models.
export const SECTIONS = ['Mod', 'Sound'] as const;
export type Section = (typeof SECTIONS)[number];

export interface ListedMod {
  gb_mod_id: number;
  has_files: boolean;
  date_modified: number;
}

export interface ListPage {
  records: ListedMod[];
  is_complete: boolean;
  per_page: number;
}

export interface FileMeta {
  gb_file_id: number;
  file_name: string;
  file_size: number;
  archive_md5: string | null;
  download_url: string;
  date_added: number;
}

// Simple in-process rate limiter: ensure at least `min_interval_ms` between
// requests. 200ms = 5 req/sec, comfortably under the 10/sec ceiling we already
// enforce in the desktop client and well below anything we'd expect GameBanana
// to push back on for a single client.
const MIN_INTERVAL_MS = 200;
let last_request_at = 0;

async function rate_limit(): Promise<void> {
  const now = Date.now();
  const wait = last_request_at + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last_request_at = Date.now();
}

async function fetchJson<T>(url: string, timeout_ms = 30_000): Promise<T> {
  await rate_limit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface IndexRecordRaw {
  _idRow: number;
  _bHasFiles?: boolean;
  _tsDateModified?: number;
  _tsDateUpdated?: number;
  _tsDateAdded?: number;
}

interface IndexResponseRaw {
  _aRecords: IndexRecordRaw[];
  _aMetadata: { _bIsComplete: boolean; _nPerpage: number; _nRecordCount: number };
}

export async function list_page(
  section: Section,
  page: number,
  per_page = 50,
): Promise<ListPage> {
  const params = new URLSearchParams({
    _idGameRow: String(DEADLOCK_GAME_ID),
    '_aFilters[Generic_Game]': String(DEADLOCK_GAME_ID),
    _nPerpage: String(per_page),
    _nPage: String(page),
    _csvProperties: '_idRow,_bHasFiles,_tsDateModified,_tsDateAdded',
  });
  const url = `${GB_BASE}/${section}/Index?${params}`;
  const raw = await fetchJson<IndexResponseRaw>(url);
  return {
    records: (raw._aRecords ?? []).map((r) => ({
      gb_mod_id: r._idRow,
      has_files: r._bHasFiles ?? false,
      date_modified: r._tsDateModified ?? r._tsDateUpdated ?? r._tsDateAdded ?? 0,
    })),
    is_complete: raw._aMetadata?._bIsComplete ?? true,
    per_page: raw._aMetadata?._nPerpage ?? per_page,
  };
}

interface FileRaw {
  _idRow: number;
  _sFile: string;
  _nFilesize: number;
  _sDownloadUrl: string;
  _sMd5Checksum?: string;
  _tsDateAdded?: number;
}

interface DetailResponseRaw {
  _aFiles?: FileRaw[];
}

export async function get_files(
  section: Section,
  gb_mod_id: number,
): Promise<FileMeta[]> {
  const url = `${GB_BASE}/${section}/${gb_mod_id}?_csvProperties=_aFiles`;
  const raw = await fetchJson<DetailResponseRaw>(url);
  return (raw._aFiles ?? []).map((f) => ({
    gb_file_id: f._idRow,
    file_name: f._sFile,
    file_size: f._nFilesize,
    archive_md5: f._sMd5Checksum && f._sMd5Checksum.length === 32 ? f._sMd5Checksum : null,
    download_url: f._sDownloadUrl,
    date_added: f._tsDateAdded ?? 0,
  }));
}
