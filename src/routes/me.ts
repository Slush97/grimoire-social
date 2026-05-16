// /v1/me  - logged-in user + their published profiles
// DELETE  - account deletion (ADR-014: hard-delete user, soft-delete profiles)

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { requireAuth } from '../middleware/auth';
import type { MeResponse, ProfileSummary } from '../shared/schemas';

export const meRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

meRoutes.use('*', requireAuth);

meRoutes.get('/', async (c) => {
  const user = c.get('user')!;

  const rows = await c.env.DB
    .prepare(
      `SELECT id, title, description, has_nsfw, mod_count, primary_hero,
              like_count, is_featured, created_at, updated_at,
              thumbnail_urls, heroes
         FROM published_profiles
        WHERE owner_user_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC`
    )
    .bind(user.id)
    .all<{
      id: string;
      title: string;
      description: string | null;
      has_nsfw: number;
      mod_count: number;
      primary_hero: string | null;
      like_count: number;
      is_featured: number;
      created_at: number;
      updated_at: number;
      thumbnail_urls: string | null;
      heroes: string | null;
    }>();

  function decodeStringArray(raw: string | null, max: number): string[] | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const values = parsed.filter((s): s is string => typeof s === 'string').slice(0, max);
      return values.length > 0 ? values : null;
    } catch {
      return null;
    }
  }

  const profiles: ProfileSummary[] = rows.results.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    has_nsfw: r.has_nsfw === 1,
    mod_count: r.mod_count,
    primary_hero: r.primary_hero,
    like_count: r.like_count,
    is_featured: r.is_featured === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
    owner: { id: user.id, display_name: user.display_name, avatar_url: user.avatar_url },
    thumbnail_urls: decodeStringArray(r.thumbnail_urls, 4),
    heroes: decodeStringArray(r.heroes, 8),
  }));

  const body: MeResponse = { user, profiles };
  return c.json(body);
});

meRoutes.delete('/', async (c) => {
  const user = c.get('user')!;
  const now = Math.floor(Date.now() / 1000);

  // Find every like by this user so we can rebalance like_count atomically.
  const likedRows = await c.env.DB
    .prepare(`SELECT profile_id FROM likes WHERE voter_user_id = ?`)
    .bind(user.id)
    .all<{ profile_id: string }>();
  const likedIds = likedRows.results.map((r) => r.profile_id);

  const stmts = [
    // Soft-delete this user's published profiles (ADR-014).
    c.env.DB.prepare(
      `UPDATE published_profiles SET deleted_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL`
    ).bind(now, user.id),
    // Hard-delete their likes; FK ON DELETE CASCADE on identity_credentials handles credentials.
    c.env.DB.prepare(`DELETE FROM likes WHERE voter_user_id = ?`).bind(user.id),
    // Mark their open reports as resolved with a flag indicating reporter went away.
    c.env.DB.prepare(
      `UPDATE reports SET resolved_at = ?, resolution = 'reporter_deleted'
        WHERE reporter_user_id = ? AND resolved_at IS NULL`
    ).bind(now, user.id),
  ];
  // Decrement like_count on every profile this user had liked.
  for (const id of likedIds) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE published_profiles SET like_count = like_count - 1 WHERE id = ? AND like_count > 0`
      ).bind(id)
    );
  }
  // Finally hard-delete the user row. Cascades to identity_credentials.
  stmts.push(c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id));

  await c.env.DB.batch(stmts);

  // Best-effort: invalidate the current session. We can't enumerate KV by
  // value, so other live sessions for this user expire naturally via TTL.
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) await c.env.SESSIONS.delete(token);
  }

  return c.body(null, 204);
});
