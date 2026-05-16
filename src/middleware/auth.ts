// Bearer-token middleware. Reads `Authorization: Bearer <session>`, looks up
// the session in KV, hydrates `c.var.user`. No token = anonymous (still allowed
// on public routes); invalid token = 401.
//
// Token NEVER reaches the renderer — the Electron main process attaches it.

import type { MiddlewareHandler } from 'hono';
import type { Env, Variables, AuthedUser } from '../env';

interface SessionEntry {
  user_id: string;
  exp: number;
}

export const optionalAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    await next();
    return;
  }
  const token = header.slice(7).trim();
  if (!token) {
    await next();
    return;
  }
  const raw = await c.env.SESSIONS.get(token, 'json') as SessionEntry | null;
  if (!raw || raw.exp < Math.floor(Date.now() / 1000)) {
    if (raw) {
      await c.env.SESSIONS.delete(token);
    }
    await next();
    return;
  }
  const user = await c.env.DB
    .prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ? AND banned_at IS NULL')
    .bind(raw.user_id)
    .first<AuthedUser>();
  if (user) {
    c.set('user', user);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'authentication required' }, 401);
  }
  await next();
  return;
};

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'admin token required' }, 401);
  }
  const token = header.slice(7).trim();
  if (token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'admin token required' }, 401);
  }
  await next();
  return;
};
