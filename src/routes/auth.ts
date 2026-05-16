// Steam OpenID auth. Three routes:
//   GET  /v1/auth/steam/begin     -> 302 to Steam (or JSON redirect URL)
//   GET  /v1/auth/steam/callback  -> verify, upsert user, issue session
//   POST /v1/auth/logout          -> invalidate session
//
// The callback redirects back to a `grimoire://` URL the Electron main
// process intercepts. Token never reaches the renderer.

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { rateLimitOrFail } from '../middleware/rateLimit';
import { buildRedirectUrl, verifyCallback, fetchPlayerSummary } from '../auth/steamOpenID';
import {
  findUserBySteamId,
  createUserWithSteamCredential,
  refreshUserProfile,
} from '../db/queries';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

authRoutes.get('/steam/begin', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const limited = await rateLimitOrFail(c, c.env.AUTH_RL, `auth:${ip}`, 60);
  if (limited) return limited;

  const url = buildRedirectUrl({
    realm: c.env.STEAM_REALM,
    returnTo: c.env.STEAM_RETURN_TO,
  });
  // Default to a 302 — works with `<a href>` and BrowserWindow loadURL.
  // Pass ?json=1 if a caller wants the URL back as JSON instead.
  if (c.req.query('json')) {
    return c.json({ redirect_url: url });
  }
  return c.redirect(url, 302);
});

authRoutes.get('/steam/callback', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const verified = await verifyCallback(params);
  if (!verified) {
    return c.json({ error: 'invalid Steam openid response' }, 401);
  }

  // Upsert user. If we already have them, optionally refresh display_name
  // and avatar from Steam (best-effort; failure is non-fatal).
  let user = await findUserBySteamId(c.env, verified.steamid64);
  const summary = await fetchPlayerSummary(verified.steamid64, c.env.STEAM_API_KEY);

  if (!user) {
    user = await createUserWithSteamCredential(c.env, {
      steamid64: verified.steamid64,
      display_name: summary?.personaname ?? `Player ${verified.steamid64.slice(-4)}`,
      avatar_url: summary?.avatarfull ?? null,
    });
  } else if (summary) {
    await refreshUserProfile(c.env, user.id, {
      display_name: summary.personaname,
      avatar_url: summary.avatarfull,
    });
    user = { ...user, display_name: summary.personaname, avatar_url: summary.avatarfull };
  }

  if (user.banned_at !== null) {
    return c.json({ error: 'account banned' }, 403);
  }

  // Mint a session token. 256 bits of entropy, base32-ish encoding.
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const ttl = Number(c.env.SESSION_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  await c.env.SESSIONS.put(
    token,
    JSON.stringify({ user_id: user.id, exp }),
    { expirationTtl: ttl }
  );

  // Bounce back to the Electron app via a custom-scheme URL the main process
  // intercepts. The desktop app registers `grimoire://` at install time.
  const target = new URL('grimoire://auth/done');
  target.searchParams.set('token', token);
  target.searchParams.set('expires_at', String(exp));
  return c.redirect(target.toString(), 302);
});

authRoutes.post('/logout', async (c) => {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) await c.env.SESSIONS.delete(token);
  }
  return c.body(null, 204);
});
