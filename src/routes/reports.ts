// POST /v1/profiles/:id/report
//
// Throttled via the PublishWindow DO (5/day per user). Pure write, no
// notification. Admin CLI reads from the reports table.

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { requireAuth } from '../middleware/auth';
import { checkPublishWindow } from '../middleware/rateLimit';
import { ReportRequest } from '../shared/schemas';

export const reportRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

reportRoutes.post('/:id/report', requireAuth, async (c) => {
  const user = c.get('user')!;
  const limited = await checkPublishWindow(c, user.id, 'report');
  if (limited) return limited;

  const id = c.req.param('id');
  const exists = await c.env.DB
    .prepare(`SELECT 1 FROM published_profiles WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!exists) return c.json({ error: 'not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = ReportRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', issues: parsed.error.flatten() }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `INSERT INTO reports (profile_id, reporter_user_id, reason, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(id, user.id, parsed.data.reason ?? null, now)
    .run();

  return c.body(null, 204);
});
