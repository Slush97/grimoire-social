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
  // INSERT + increment + readback in one batch so they commit atomically.
  // D1.batch runs the array as a single transaction, so a partial failure
  // can't leave the like row inserted but the counter unchanged. The UPDATE
  // adds `changes()` from the INSERT — 1 for a fresh row, 0 if OR IGNORE
  // swallowed a duplicate — which both makes the counter exact and avoids a
  // second read against the likes table.
  const results = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT OR IGNORE INTO likes (profile_id, voter_user_id, created_at)
         VALUES (?, ?, ?)`
      )
      .bind(id, user.id, now),
    c.env.DB
      .prepare(
        `UPDATE published_profiles
            SET like_count = like_count + changes()
          WHERE id = ?`
      )
      .bind(id),
    c.env.DB
      .prepare(`SELECT like_count FROM published_profiles WHERE id = ?`)
      .bind(id),
  ]);
  const fresh = (results[2] as D1Result<{ like_count: number }>).results?.[0];

  const body: LikeResponse = {
    profile_id: id,
    like_count: fresh?.like_count ?? 0,
    viewer_has_liked: true,
  };
  return c.json(body);
});

likeRoutes.delete('/:id/like', async (c) => {
  const user = c.get('user')!;
  // Same throttle as POST. Without this, DELETE was the cheapest way to burn
  // D1 writes against a signed-in user (two writes per call).
  const limited = await rateLimitOrFail(c, c.env.LIKE_RL, `like:${user.id}`, 60);
  if (limited) return limited;

  const id = c.req.param('id');

  // DELETE + decrement + readback as one transaction. Counter decrement uses
  // `changes()` from the DELETE so the math is exact whether the row existed
  // or not — and we don't risk negative counts because the WHERE clause
  // guards against underflow.
  const results = await c.env.DB.batch([
    c.env.DB
      .prepare(`DELETE FROM likes WHERE profile_id = ? AND voter_user_id = ?`)
      .bind(id, user.id),
    c.env.DB
      .prepare(
        `UPDATE published_profiles
            SET like_count = like_count - changes()
          WHERE id = ? AND like_count >= changes()`
      )
      .bind(id),
    c.env.DB
      .prepare(`SELECT like_count FROM published_profiles WHERE id = ?`)
      .bind(id),
  ]);
  const fresh = (results[2] as D1Result<{ like_count: number }>).results?.[0];
  if (!fresh) return c.json({ error: 'not found' }, 404);

  const body: LikeResponse = {
    profile_id: id,
    like_count: fresh.like_count,
    viewer_has_liked: false,
  };
  return c.json(body);
});
