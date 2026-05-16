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
