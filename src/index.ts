// Hono app entry. All routes prefixed with /v1/ — see ADR-005.
// Never break v1; add /v2/ alongside for breaking changes.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Variables } from './env';
import { optionalAuth } from './middleware/auth';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { profileRoutes } from './routes/profiles';
import { likeRoutes } from './routes/likes';
import { reportRoutes } from './routes/reports';
import { adminRoutes } from './routes/admin';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Permissive CORS for now — the only consumer is the Electron client (no
// Origin checks needed on desktop). Tighten if a web frontend ever appears.
app.use('*', cors({ origin: '*', maxAge: 86400 }));

// Hydrate c.var.user on every request that has a Bearer token.
app.use('/v1/*', optionalAuth);

app.get('/', (c) => c.text('grimoire-social ok'));
app.get('/v1/health', (c) => c.json({ ok: true }));

app.route('/v1/auth', authRoutes);
app.route('/v1/me', meRoutes);
app.route('/v1/profiles', profileRoutes);
app.route('/v1/profiles', likeRoutes);    // /:id/like lives here
app.route('/v1/profiles', reportRoutes);  // /:id/report lives here
app.route('/v1/admin', adminRoutes);

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: 'internal error' }, 500);
});

export default app;

// Re-export the DO class so wrangler can find it as a module export.
export { PublishWindowDO } from './do/PublishWindowDO';
