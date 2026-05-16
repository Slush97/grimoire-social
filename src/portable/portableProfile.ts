// Workers-compatible port of the Electron client's portable profile parser
// (../grimoire/electron/main/services/portableProfile.ts).
//
// Differences from the Electron version:
//   - `gunzip` uses `DecompressionStream('gzip')` instead of Node `zlib`, so
//     `parsePortableProfile` is async.
//   - Drops the exporter / resolver / installer surface. Server-side we only
//     need decode + validate + derive metadata for ranking and rejection.
//
// Untrusted input: every share code we accept here came from a client we do
// not control. Treat the entire payload as hostile until validated.

import { inferHeroFromTitle } from './inferHero';

export const PORTABLE_PROFILE_FORMAT = 'mod-profile';
export const PORTABLE_PROFILE_SHARE_PREFIX = 'mp1:';

// Matches social-architecture.md §7 publish-time limits.
export const MAX_INFLATED_BLOB_BYTES = 16 * 1024;
export const MAX_MODS = 100;

export type ModSource = 'gamebanana' | (string & { _open?: never });

export interface PortableGameId {
  steamAppId?: number;
  gameBananaGameId?: number;
  name?: string;
}

export interface PortableProfileMeta {
  name: string;
  description?: string;
  author?: string;
}

export interface PortableExportedBy {
  tool: string;
  version: string;
}

export interface PortableGameBananaRef {
  submissionId: number;
  fileId: number;
  section?: string;
}

export type PortableModRef = PortableGameBananaRef | Record<string, unknown>;

export interface PortableModHint {
  name?: string;
  category?: string;
  fileLabel?: string;
  originalFileName?: string;
  thumbnailUrl?: string;
  nsfw?: boolean;
  isArchived?: boolean;
}

export interface PortableModEntry {
  source: ModSource;
  ref: PortableModRef;
  enabled: boolean;
  priority: number;
  hint?: PortableModHint;
}

export interface PortableProfile {
  format: typeof PORTABLE_PROFILE_FORMAT;
  schemaVersion: string;
  game: PortableGameId;
  exportedAt: string;
  exportedBy: PortableExportedBy;
  profile: PortableProfileMeta;
  mods: PortableModEntry[];
  extensions?: Record<string, unknown>;
}

// ---------- base64url ----------

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- decode / parse ----------

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export class PortableProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortableProfileError';
  }
}

/** Decode an mp1:... share code to its JSON string. Throws on bad prefix,
 *  bad base64, bad gzip, or if the inflated payload exceeds the cap. */
export async function decodeShareCode(code: string): Promise<string> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PORTABLE_PROFILE_SHARE_PREFIX)) {
    throw new PortableProfileError(
      `Share code missing "${PORTABLE_PROFILE_SHARE_PREFIX}" prefix`
    );
  }
  const body = trimmed.slice(PORTABLE_PROFILE_SHARE_PREFIX.length);

  let compressed: Uint8Array;
  try {
    compressed = base64urlDecode(body);
  } catch (err) {
    throw new PortableProfileError(
      `Invalid base64url: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let inflated: Uint8Array;
  try {
    inflated = await gunzip(compressed);
  } catch (err) {
    throw new PortableProfileError(
      `Invalid gzip payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (inflated.byteLength > MAX_INFLATED_BLOB_BYTES) {
    throw new PortableProfileError(
      `Inflated payload ${inflated.byteLength} bytes exceeds ${MAX_INFLATED_BLOB_BYTES} cap`
    );
  }

  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(inflated);
}

/** Validate a parsed object as a v1 portable profile. Mirrors the Electron
 *  client's validator so codes round-trip identically. */
export function validatePortable(obj: unknown): PortableProfile {
  if (!obj || typeof obj !== 'object') throw new PortableProfileError('Not a JSON object');
  const o = obj as Record<string, unknown>;

  if (o.format !== PORTABLE_PROFILE_FORMAT) {
    throw new PortableProfileError(
      `Expected format "${PORTABLE_PROFILE_FORMAT}", got "${String(o.format)}"`
    );
  }
  if (typeof o.schemaVersion !== 'string') {
    throw new PortableProfileError('Missing schemaVersion');
  }
  const major = o.schemaVersion.split('.')[0];
  if (major !== '1') {
    throw new PortableProfileError(`Unsupported schemaVersion: ${o.schemaVersion}`);
  }

  if (!o.game || typeof o.game !== 'object') throw new PortableProfileError('Missing game');
  if (!o.profile || typeof o.profile !== 'object') throw new PortableProfileError('Missing profile');
  if (!Array.isArray(o.mods)) throw new PortableProfileError('Missing mods array');

  const profileMeta = o.profile as Record<string, unknown>;
  if (typeof profileMeta.name !== 'string' || profileMeta.name.trim() === '') {
    throw new PortableProfileError('Profile name required');
  }

  for (let i = 0; i < o.mods.length; i++) {
    const m = o.mods[i] as Record<string, unknown>;
    if (typeof m.source !== 'string') throw new PortableProfileError(`mods[${i}].source missing`);
    if (!m.ref || typeof m.ref !== 'object') throw new PortableProfileError(`mods[${i}].ref missing`);
    if (typeof m.enabled !== 'boolean') throw new PortableProfileError(`mods[${i}].enabled missing`);
    if (typeof m.priority !== 'number') throw new PortableProfileError(`mods[${i}].priority missing`);

    if (m.source === 'gamebanana') {
      const ref = m.ref as Record<string, unknown>;
      if (typeof ref.submissionId !== 'number') {
        throw new PortableProfileError(`mods[${i}].ref.submissionId missing`);
      }
      if (typeof ref.fileId !== 'number') {
        throw new PortableProfileError(`mods[${i}].ref.fileId missing`);
      }
    }
  }

  return obj as PortableProfile;
}

/** Accept either a raw JSON string or an mp1: share code. */
export async function parsePortableProfile(input: string): Promise<PortableProfile> {
  const trimmed = input.trim();
  const json = trimmed.startsWith(PORTABLE_PROFILE_SHARE_PREFIX)
    ? await decodeShareCode(trimmed)
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new PortableProfileError(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return validatePortable(parsed);
}

// ---------- derived metadata ----------

export interface PortableDerived {
  has_nsfw: boolean;
  mod_count: number;
  primary_hero: string | null;
}

/** Compute the columns we denormalize for list/sort views. The publish handler
 *  uses these AND ignores whatever the client claimed (ADR-006). `publishTitle`
 *  is the user-facing title the publisher chose — used as a fallback signal
 *  when no individual mod hint resolves to a hero (e.g. crosshair-only or
 *  utility profiles).
 *
 *  primary_hero strategy: tally inferred heroes across mod hints; pick the
 *  modal one. Fall back to the embedded profile name, then the publish title.
 *  Returns null only if every signal fails. */
export function derivePortableMetadata(
  profile: PortableProfile,
  publishTitle: string
): PortableDerived {
  const mods = profile.mods;
  const hasNsfw = mods.some((m) => m.hint?.nsfw === true);

  const tally = new Map<string, number>();
  for (const mod of mods) {
    const hint = mod.hint;
    if (!hint) continue;
    const signal = hint.name || hint.fileLabel || hint.category || '';
    const hero = inferHeroFromTitle(signal);
    if (hero) tally.set(hero, (tally.get(hero) ?? 0) + 1);
  }

  let primaryHero: string | null = null;
  if (tally.size > 0) {
    let bestCount = 0;
    for (const [hero, count] of tally) {
      if (count > bestCount) {
        bestCount = count;
        primaryHero = hero;
      }
    }
  }
  if (!primaryHero) primaryHero = inferHeroFromTitle(profile.profile.name);
  if (!primaryHero) primaryHero = inferHeroFromTitle(publishTitle);

  return {
    has_nsfw: hasNsfw,
    mod_count: mods.length,
    primary_hero: primaryHero,
  };
}
