// Rate limiting wrappers. Two backends:
//   1. Cloudflare Rate Limit API binding — period must be 10 or 60s (verified).
//      Used for high-frequency throttles (likes, auth begin).
//   2. PublishWindowDO — per-user arbitrary-window gate (publish 1/10min, etc).
//
// ADR-004: DO is mandatory for windows the RL API can't express.

import type { Context } from 'hono';
import type { Env, Variables } from '../env';

export async function rateLimitOrFail(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  binding: RateLimit,
  key: string,
  retryAfterSeconds: number
): Promise<Response | null> {
  const result = await binding.limit({ key });
  if (result.success) return null;
  return c.json(
    { error: 'rate limit exceeded' },
    429,
    { 'Retry-After': String(retryAfterSeconds) }
  );
}

// Asks the per-user PublishWindow DO whether `action` is allowed right now.
// Returns null on success, or a 429 Response on denial with a Retry-After
// hint computed by the DO.
export async function checkPublishWindow(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  userId: string,
  action: 'publish' | 'report'
): Promise<Response | null> {
  const id = c.env.PUBLISH_WINDOW.idFromName(userId);
  const stub = c.env.PUBLISH_WINDOW.get(id);
  const res = await stub.fetch(`https://do.local/check?action=${action}`, { method: 'POST' });
  if (res.ok) return null;
  const retryAfter = res.headers.get('Retry-After') ?? '60';
  return c.json(
    { error: `${action} rate limit: try again later` },
    429,
    { 'Retry-After': retryAfter }
  );
}
