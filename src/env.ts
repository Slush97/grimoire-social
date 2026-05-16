// Worker bindings, sourced from wrangler.toml. Hono picks this up via the
// generic on `new Hono<{ Bindings: Env }>()`.

import type { PublishWindowDO } from './do/PublishWindowDO';

export interface Env {
  // D1: relational source of truth.
  DB: D1Database;

  // KV: session token -> { user_id, exp }.
  SESSIONS: KVNamespace;

  // Rate Limit API bindings. period must be 10 or 60 (CF docs verbatim).
  LIKE_RL: RateLimit;
  AUTH_RL: RateLimit;

  // Per-user durable object for arbitrary-window gates (publish 1/10min, etc).
  PUBLISH_WINDOW: DurableObjectNamespace<PublishWindowDO>;

  // Vars (non-secret).
  STEAM_REALM: string;
  STEAM_RETURN_TO: string;
  SESSION_TTL_SECONDS: string;

  // Secrets (set via `wrangler secret put`).
  STEAM_API_KEY: string;
  ADMIN_TOKEN: string;
}

export interface AuthedUser {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

// Hono context variables populated by middleware.
export interface Variables {
  user?: AuthedUser;
}
