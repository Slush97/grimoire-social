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
