# grimoire-social

Backend service for Grimoire profile sharing and likes. Cloudflare Worker + D1 + KV + Durable Objects.

See `../grimoire/docs/social-architecture.md` and `../grimoire/docs/social-architecture-decisions.md` for the full design.

## First-time setup

```bash
pnpm install

# Create the D1 database, copy the printed database_id into wrangler.toml
pnpm exec wrangler d1 create grimoire-social

# Create the KV namespace, copy the printed id into wrangler.toml
pnpm exec wrangler kv namespace create SESSIONS

# Apply migrations locally
pnpm db:migrate:local

# Set secrets (interactive)
pnpm secret:steam-key
pnpm secret:admin-token
```

## Dev loop

```bash
pnpm dev          # local Worker on http://localhost:8787
pnpm typecheck    # tsc --noEmit
```

## Deploy

```bash
pnpm db:migrate:remote   # apply pending migrations to prod D1
pnpm deploy              # ship the Worker
```

## Repo layout

```
src/
  index.ts              Hono app entry, route mounting
  env.ts                Bindings type (DB, SESSIONS, rate limiters, DO)
  middleware/
    auth.ts             Bearer token -> user context
    rateLimit.ts        RL API + DO wrappers
  routes/
    auth.ts             Steam OpenID begin/callback/logout
    me.ts               GET /me, DELETE /me (account deletion)
    profiles.ts         Publish, list, detail, soft-delete
    likes.ts            Like / unlike
    reports.ts          Report a profile
  auth/
    steamOpenID.ts      Hand-rolled OpenID 2.0 verifier (Workers-compatible)
  db/
    queries.ts          Typed D1 query helpers
  do/
    PublishWindowDO.ts  Per-user 10-min publish gate
  shared/
    schemas.ts          Zod wire-format schemas (future: @grimoire/social-types)
migrations/
  0001_initial.sql      Initial schema
```

## Conventions

- All routes prefixed with `/v1/`. Never break v1 — additive changes only. Breaking changes go to `/v2/` alongside.
- Server validates every inbound body with Zod from `src/shared/schemas.ts`. Never trust client-supplied derived fields (`has_nsfw`, `mod_count`); recompute server-side.
- Migrations are append-only numbered SQL files. Never edit a shipped migration.
- No tests yet (matches grimoire's own posture). Add them when the surface stabilizes.
