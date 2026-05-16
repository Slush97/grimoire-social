// /v1/admin/*
//
// Internal moderation API. Gated by `requireAdmin` (matches `ADMIN_TOKEN`
// from secrets). All writes are idempotent in the sense that running them
// twice in a row is harmless — the second call hits a no-op WHERE clause.
//
// Not part of the v1 wire contract with the Electron client. These endpoints
// are consumed by the in-repo CLI at `cli/admin.ts` and may evolve without
// the additive-only guarantee that user-facing /v1/* routes carry.

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../env';
import { requireAdmin } from '../middleware/auth';
import {
  base64urlEncode,
  derivePortableMetadata,
  parsePortableProfile,
  PORTABLE_PROFILE_SHARE_PREFIX,
} from '../portable/portableProfile';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
adminRoutes.use('*', requireAdmin);

const PAGE_SIZE = 50;

// ---------- request schemas ----------

const ListReportsQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  page: z.coerce.number().int().min(1).default(1),
});

const ResolveReportRequest = z.object({
  // Action endpoints set 'deleted' / 'banned' themselves; here we only accept
  // 'dismissed' (close without taking action).
  resolution: z.literal('dismissed'),
  reason: z.string().trim().max(500).optional(),
});

const ReasonOnlyRequest = z.object({
  reason: z.string().trim().max(500).optional(),
});

const FeatureProfileRequest = z.object({
  featured: z.boolean(),
});

const BanUserRequest = z.object({
  banned: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

// ---------- response shapes (consumed by cli/admin.ts) ----------

export interface AdminReportRow {
  id: number;
  profile_id: string;
  profile_title: string | null;
  profile_deleted: boolean;
  owner_user_id: string | null;
  owner_name: string | null;
  owner_steam_id: string | null;
  reporter_user_id: string;
  reporter_name: string | null;
  reporter_steam_id: string | null;
  reason: string | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
  resolution_reason: string | null;
}

export interface AdminReportsResponse {
  page: number;
  page_size: number;
  total: number;
  reports: AdminReportRow[];
}

// ---------- routes ----------

adminRoutes.get('/reports', async (c) => {
  const parsed = ListReportsQuery.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams)
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid query', issues: parsed.error.flatten() }, 400);
  }
  const { status, page } = parsed.data;
  const offset = (page - 1) * PAGE_SIZE;

  const where =
    status === 'open'
      ? 'r.resolved_at IS NULL'
      : status === 'resolved'
        ? 'r.resolved_at IS NOT NULL'
        : '1=1';

  const rows = await c.env.DB
    .prepare(
      `SELECT r.id, r.profile_id, r.reporter_user_id, r.reason, r.created_at,
              r.resolved_at, r.resolution, r.resolution_reason,
              p.title         AS profile_title,
              p.owner_user_id AS profile_owner_id,
              p.deleted_at    AS profile_deleted_at,
              owner.display_name              AS owner_name,
              owner_cred.provider_user_id     AS owner_steam_id,
              reporter.display_name           AS reporter_name,
              reporter_cred.provider_user_id  AS reporter_steam_id
         FROM reports r
         LEFT JOIN published_profiles p     ON p.id = r.profile_id
         LEFT JOIN users owner              ON owner.id = p.owner_user_id
         LEFT JOIN identity_credentials owner_cred
                ON owner_cred.user_id = owner.id AND owner_cred.provider = 'steam'
         LEFT JOIN users reporter           ON reporter.id = r.reporter_user_id
         LEFT JOIN identity_credentials reporter_cred
                ON reporter_cred.user_id = reporter.id AND reporter_cred.provider = 'steam'
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?`
    )
    .bind(PAGE_SIZE, offset)
    .all<{
      id: number; profile_id: string; reporter_user_id: string;
      reason: string | null; created_at: number;
      resolved_at: number | null; resolution: string | null;
      resolution_reason: string | null;
      profile_title: string | null; profile_owner_id: string | null;
      profile_deleted_at: number | null;
      owner_name: string | null; owner_steam_id: string | null;
      reporter_name: string | null; reporter_steam_id: string | null;
    }>();

  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM reports r WHERE ${where}`)
    .first<{ n: number }>();

  const body: AdminReportsResponse = {
    page,
    page_size: PAGE_SIZE,
    total: total?.n ?? 0,
    reports: rows.results.map((r) => ({
      id: r.id,
      profile_id: r.profile_id,
      profile_title: r.profile_title,
      profile_deleted: r.profile_deleted_at !== null,
      owner_user_id: r.profile_owner_id,
      owner_name: r.owner_name,
      owner_steam_id: r.owner_steam_id,
      reporter_user_id: r.reporter_user_id,
      reporter_name: r.reporter_name,
      reporter_steam_id: r.reporter_steam_id,
      reason: r.reason,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      resolution: r.resolution,
      resolution_reason: r.resolution_reason,
    })),
  };
  return c.json(body);
});

adminRoutes.post('/reports/:id/resolve', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) return c.json({ error: 'invalid report id' }, 400);

  const body = await c.req.json().catch(() => null);
  const parsed = ResolveReportRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', issues: parsed.error.flatten() }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await c.env.DB
    .prepare(
      `UPDATE reports SET resolved_at = ?, resolution = ?, resolution_reason = ?
        WHERE id = ? AND resolved_at IS NULL`
    )
    .bind(now, parsed.data.resolution, parsed.data.reason ?? null, id)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: 'report not found or already resolved' }, 404);
  }
  return c.json({ ok: true });
});

adminRoutes.post('/profiles/:id/delete', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = ReasonOnlyRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', issues: parsed.error.flatten() }, 400);
  }

  const profile = await c.env.DB
    .prepare(`SELECT 1 FROM published_profiles WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!profile) return c.json({ error: 'not found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE published_profiles SET deleted_at = ?, deletion_reason = ?
          WHERE id = ?`
      )
      .bind(now, parsed.data.reason ?? null, id),
    c.env.DB
      .prepare(
        `UPDATE reports SET resolved_at = ?, resolution = 'deleted',
                            resolution_reason = ?
          WHERE profile_id = ? AND resolved_at IS NULL`
      )
      .bind(now, parsed.data.reason ?? null, id),
  ]);
  return c.json({ ok: true });
});

adminRoutes.post('/profiles/:id/feature', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = FeatureProfileRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', issues: parsed.error.flatten() }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await c.env.DB
    .prepare(
      `UPDATE published_profiles SET is_featured = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(parsed.data.featured ? 1 : 0, now, id)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true, featured: parsed.data.featured });
});

adminRoutes.post('/users/:id/ban', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = BanUserRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', issues: parsed.error.flatten() }, 400);
  }

  const user = await c.env.DB
    .prepare(`SELECT 1 FROM users WHERE id = ?`)
    .bind(id)
    .first();
  if (!user) return c.json({ error: 'not found' }, 404);

  const now = Math.floor(Date.now() / 1000);

  if (parsed.data.banned) {
    // Architecture §7: banning cascades to soft-delete the user's profiles
    // and close any open reports against them.
    await c.env.DB.batch([
      c.env.DB
        .prepare(`UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?`)
        .bind(now, parsed.data.reason ?? null, id),
      c.env.DB
        .prepare(
          `UPDATE published_profiles
              SET deleted_at = ?, deletion_reason = 'owner banned'
            WHERE owner_user_id = ? AND deleted_at IS NULL`
        )
        .bind(now, id),
      c.env.DB
        .prepare(
          `UPDATE reports SET resolved_at = ?, resolution = 'banned',
                              resolution_reason = ?
            WHERE profile_id IN (SELECT id FROM published_profiles WHERE owner_user_id = ?)
              AND resolved_at IS NULL`
        )
        .bind(now, parsed.data.reason ?? null, id),
    ]);
  } else {
    // Unban only flips the user state. Profiles remain soft-deleted; the
    // admin can selectively un-delete via SQL if a ban is overturned.
    await c.env.DB
      .prepare(`UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?`)
      .bind(id)
      .run();
  }
  return c.json({ ok: true, banned: parsed.data.banned });
});

// POST /v1/admin/backfill-derived
//
// Re-derive `thumbnail_urls` and `heroes` for every non-deleted published
// profile from its stored `profile_blob`. Idempotent. Use after adding a new
// derived column so existing rows pick it up without needing each owner to
// republish (which is rate-gated to 1/10min and impractical for bulk).
//
// Walks the table in pages to keep request CPU bounded; the response totals
// success/skip/fail counts and lists any rows that failed (with the error
// message so the admin can investigate). NSFW filtering matches the publish
// path — driven by per-mod hints inside the blob.
adminRoutes.post('/backfill-derived', async (c) => {
  const PAGE = 25;
  let cursorCreatedAt: number | null = null;
  let cursorId: string | null = null;
  let updated = 0;
  let skipped = 0;
  const failures: Array<{ id: string; error: string }> = [];

  type Row = { id: string; profile_blob: ArrayBuffer; created_at: number };
  for (;;) {
    // Keyset pagination on (created_at, id) so we don't drift if rows mutate
    // mid-walk. Only walks non-deleted rows.
    const stmt = cursorCreatedAt === null
      ? c.env.DB
          .prepare(
            `SELECT id, profile_blob, created_at
               FROM published_profiles
              WHERE deleted_at IS NULL
              ORDER BY created_at ASC, id ASC
              LIMIT ?`
          )
          .bind(PAGE)
      : c.env.DB
          .prepare(
            `SELECT id, profile_blob, created_at
               FROM published_profiles
              WHERE deleted_at IS NULL
                AND (created_at > ? OR (created_at = ? AND id > ?))
              ORDER BY created_at ASC, id ASC
              LIMIT ?`
          )
          .bind(cursorCreatedAt, cursorCreatedAt, cursorId, PAGE);
    const page = await stmt.all<Row>();

    const rows: Row[] = page.results;
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        // Re-encode the gzipped blob as a share code so we can reuse the
        // same parser the publish path uses (which enforces inflated size
        // cap and validates structure).
        const blobBytes = new Uint8Array(row.profile_blob);
        const shareCode = `${PORTABLE_PROFILE_SHARE_PREFIX}${base64urlEncode(blobBytes)}`;
        const portable = await parsePortableProfile(shareCode);
        const derived = derivePortableMetadata(portable, portable.profile.name);
        const thumbnailUrlsJson = derived.thumbnail_urls.length > 0
          ? JSON.stringify(derived.thumbnail_urls)
          : null;
        const heroesJson = derived.heroes.length > 0
          ? JSON.stringify(derived.heroes)
          : null;
        await c.env.DB
          .prepare(
            `UPDATE published_profiles
                SET thumbnail_urls = ?, heroes = ?, primary_hero = ?, has_nsfw = ?, mod_count = ?
              WHERE id = ?`
          )
          .bind(
            thumbnailUrlsJson,
            heroesJson,
            derived.primary_hero,
            derived.has_nsfw ? 1 : 0,
            derived.mod_count,
            row.id
          )
          .run();
        updated++;
      } catch (err) {
        skipped++;
        failures.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const last = rows[rows.length - 1]!;
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
    if (rows.length < PAGE) break;
  }

  return c.json({
    ok: true,
    updated,
    skipped,
    failures,
  });
});

// GET /v1/admin/stats
//
// Single-shot overview: row counts and 24h activity. Cheap aggregate queries
// against D1. Consumed by the admin dashboard's home panel.
export interface AdminStats {
  users: { total: number; banned: number; new_24h: number };
  profiles: { total: number; deleted: number; featured: number; new_24h: number };
  likes: { total: number; new_24h: number };
  reports: { open: number; total: number; new_24h: number };
}

adminRoutes.get('/stats', async (c) => {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const rows = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`).bind(since24h),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM published_profiles`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM published_profiles WHERE deleted_at IS NOT NULL`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM published_profiles WHERE is_featured = 1 AND deleted_at IS NULL`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM published_profiles WHERE created_at >= ?`).bind(since24h),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM likes`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM likes WHERE created_at >= ?`).bind(since24h),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports`),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?`).bind(since24h),
  ]);
  const n = (i: number): number => (rows[i]?.results?.[0] as { n: number } | undefined)?.n ?? 0;
  const body: AdminStats = {
    users:    { total: n(0),  banned: n(1),   new_24h: n(2) },
    profiles: { total: n(3),  deleted: n(4),  featured: n(5), new_24h: n(6) },
    likes:    { total: n(7),  new_24h: n(8) },
    reports:  { open: n(9),   total: n(10),   new_24h: n(11) },
  };
  return c.json(body);
});

// GET /v1/admin/profiles
//
// Search + filter the published_profiles table. Lets the admin browse beyond
// the report queue (e.g. to curate features) without needing direct D1 access.
//
// Query params (all optional):
//   q          - substring match on title (case-insensitive)
//   hero       - exact match on primary_hero
//   owner      - exact match on owner_user_id
//   featured   - 'true' | 'false'
//   deleted    - 'true' | 'false' | 'any' (default 'false' — hide soft-deleted)
//   sort       - 'new' | 'top' | 'updated' (default 'new')
//   page       - 1-indexed
const ListAdminProfilesQuery = z.object({
  q: z.string().trim().max(80).optional(),
  hero: z.string().trim().max(40).optional(),
  owner: z.string().trim().max(60).optional(),
  featured: z.enum(['true', 'false']).optional(),
  deleted: z.enum(['true', 'false', 'any']).default('false'),
  sort: z.enum(['new', 'top', 'updated']).default('new'),
  page: z.coerce.number().int().min(1).default(1),
});

export interface AdminProfileRow {
  id: string;
  title: string;
  owner_user_id: string;
  owner_name: string | null;
  owner_steam_id: string | null;
  primary_hero: string | null;
  has_nsfw: boolean;
  mod_count: number;
  like_count: number;
  is_featured: boolean;
  is_deleted: boolean;
  created_at: number;
  updated_at: number;
  thumbnail_urls: string[] | null;
  heroes: string[] | null;
  open_reports: number;
}
export interface AdminProfilesResponse {
  page: number;
  page_size: number;
  total: number;
  profiles: AdminProfileRow[];
}

adminRoutes.get('/profiles', async (c) => {
  const parsed = ListAdminProfilesQuery.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams)
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid query', issues: parsed.error.flatten() }, 400);
  }
  const { q, hero, owner, featured, deleted, sort, page } = parsed.data;
  const offset = (page - 1) * PAGE_SIZE;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (deleted === 'false') where.push('p.deleted_at IS NULL');
  else if (deleted === 'true') where.push('p.deleted_at IS NOT NULL');
  if (q) {
    where.push('LOWER(p.title) LIKE ?');
    binds.push(`%${q.toLowerCase()}%`);
  }
  if (hero) {
    where.push('p.primary_hero = ?');
    binds.push(hero);
  }
  if (owner) {
    where.push('p.owner_user_id = ?');
    binds.push(owner);
  }
  if (featured === 'true') where.push('p.is_featured = 1');
  if (featured === 'false') where.push('p.is_featured = 0');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orderSql = sort === 'top'
    ? 'p.like_count DESC, p.created_at DESC'
    : sort === 'updated'
      ? 'p.updated_at DESC'
      : 'p.created_at DESC';

  const rows = await c.env.DB
    .prepare(
      `SELECT p.id, p.title, p.owner_user_id, p.primary_hero, p.has_nsfw,
              p.mod_count, p.like_count, p.is_featured, p.created_at, p.updated_at,
              p.deleted_at, p.thumbnail_urls, p.heroes,
              u.display_name AS owner_name,
              cred.provider_user_id AS owner_steam_id,
              (SELECT COUNT(*) FROM reports r
                 WHERE r.profile_id = p.id AND r.resolved_at IS NULL) AS open_reports
         FROM published_profiles p
         LEFT JOIN users u ON u.id = p.owner_user_id
         LEFT JOIN identity_credentials cred
                ON cred.user_id = u.id AND cred.provider = 'steam'
         ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`
    )
    .bind(...binds, PAGE_SIZE, offset)
    .all<{
      id: string; title: string; owner_user_id: string;
      primary_hero: string | null; has_nsfw: number; mod_count: number;
      like_count: number; is_featured: number;
      created_at: number; updated_at: number; deleted_at: number | null;
      thumbnail_urls: string | null; heroes: string | null;
      owner_name: string | null; owner_steam_id: string | null;
      open_reports: number;
    }>();

  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM published_profiles p ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const parseJsonArr = (raw: string | null, max: number): string[] | null => {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return null;
      const arr = v.filter((s): s is string => typeof s === 'string').slice(0, max);
      return arr.length > 0 ? arr : null;
    } catch { return null; }
  };

  const body: AdminProfilesResponse = {
    page,
    page_size: PAGE_SIZE,
    total: total?.n ?? 0,
    profiles: rows.results.map((r) => ({
      id: r.id,
      title: r.title,
      owner_user_id: r.owner_user_id,
      owner_name: r.owner_name,
      owner_steam_id: r.owner_steam_id,
      primary_hero: r.primary_hero,
      has_nsfw: r.has_nsfw === 1,
      mod_count: r.mod_count,
      like_count: r.like_count,
      is_featured: r.is_featured === 1,
      is_deleted: r.deleted_at !== null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      thumbnail_urls: parseJsonArr(r.thumbnail_urls, 4),
      heroes: parseJsonArr(r.heroes, 8),
      open_reports: r.open_reports,
    })),
  };
  return c.json(body);
});

// POST /v1/admin/profiles/:id/undelete
//
// Reverses a soft delete. Used when a ban is overturned or a delete was a
// mistake. Restores the row; existing report rows stay closed (they were
// resolved as 'deleted' or 'banned').
adminRoutes.post('/profiles/:id/undelete', async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB
    .prepare(
      `UPDATE published_profiles
          SET deleted_at = NULL, deletion_reason = NULL, updated_at = ?
        WHERE id = ? AND deleted_at IS NOT NULL`
    )
    .bind(Math.floor(Date.now() / 1000), id)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: 'not found or not deleted' }, 404);
  }
  return c.json({ ok: true });
});

// POST /v1/admin/reset-publish-window/:user_id
//
// Clears the per-user PublishWindowDO state. Use to unblock a stuck publish
// or report flow (also handy in local dev to bypass the 10-min window
// without waiting). Idempotent.
adminRoutes.post('/reset-publish-window/:user_id', async (c) => {
  const userId = c.req.param('user_id');
  if (!userId) return c.json({ error: 'missing user_id' }, 400);
  const id = c.env.PUBLISH_WINDOW.idFromName(userId);
  const stub = c.env.PUBLISH_WINDOW.get(id);
  const res = await stub.fetch('https://do.local/reset', { method: 'POST' });
  if (!res.ok) {
    return c.json({ error: 'reset failed', status: res.status }, 500);
  }
  return c.json({ ok: true, user_id: userId });
});
