// POST   /v1/profiles/:id/like   - add (idempotent)
// DELETE /v1/profiles/:id/like   - remove (idempotent)
//
// Both return the updated like_count + viewer_has_liked so the client can
// avoid a refetch (D1 read-after-write — see architecture §8.2).

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { requireAuth } from '../middleware/auth';
import { rateLimitOrFail } from '../middleware/rateLimit';
import type { LikeResponse } from '../shared/schemas';

export const likeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

likeRoutes.use('/:id/like', requireAuth);

likeRoutes.post('/:id/like', async (c) => {
  const user = c.get('user')!;
  const limited = await rateLimitOrFail(c, c.env.LIKE_RL, `like:${user.id}`, 60);
  if (limited) return limited;

  const id = c.req.param('id');
  const exists = await c.env.DB
    .prepare(`SELECT 1 FROM published_profiles WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!exists) return c.json({ error: 'not found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  // Atomic: try to insert, increment like_count only if a new row was created.
  const insert = await c.env.DB
    .prepare(
      `INSERT OR IGNORE INTO likes (profile_id, voter_user_id, created_at)
       VALUES (?, ?, ?)`
    )
    .bind(id, user.id, now)
    .run();
  if ((insert.meta?.changes ?? 0) > 0) {
    await c.env.DB
      .prepare(`UPDATE published_profiles SET like_count = like_count + 1 WHERE id = ?`)
      .bind(id)
      .run();
  }

  const fresh = await c.env.DB
    .prepare(`SELECT like_count FROM published_profiles WHERE id = ?`)
    .bind(id)
    .first<{ like_count: number }>();

  const body: LikeResponse = {
    profile_id: id,
    like_count: fresh?.like_count ?? 0,
    viewer_has_liked: true,
  };
  return c.json(body);
});

likeRoutes.delete('/:id/like', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');

  const del = await c.env.DB
    .prepare(`DELETE FROM likes WHERE profile_id = ? AND voter_user_id = ?`)
    .bind(id, user.id)
    .run();
  if ((del.meta?.changes ?? 0) > 0) {
    await c.env.DB
      .prepare(`UPDATE published_profiles SET like_count = like_count - 1 WHERE id = ? AND like_count > 0`)
      .bind(id)
      .run();
  }

  const fresh = await c.env.DB
    .prepare(`SELECT like_count FROM published_profiles WHERE id = ?`)
    .bind(id)
    .first<{ like_count: number }>();
  if (!fresh) return c.json({ error: 'not found' }, 404);

  const body: LikeResponse = {
    profile_id: id,
    like_count: fresh.like_count,
    viewer_has_liked: false,
  };
  return c.json(body);
});
