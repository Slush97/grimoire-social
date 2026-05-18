# grimoire-social

Backend service for Grimoire's profile sharing and likes. Deployed as a Cloudflare Worker; consumed exclusively by the Grimoire desktop app (Electron) at `../grimoire`.

## What it is

A small social layer that lets Grimoire users:
- Publish their portable mod profiles (the `mp1:` share codes from `../grimoire/docs/profile-spec.md`)
- Browse profiles published by others, sorted by likes / new / hero / featured
- Like a profile (one-click thumbs up; no down/star)
- Import any discovered profile via the existing client import flow
- Report profiles for moderation review

Out of scope (deliberately): comments, follows, profile remixes, multi-game support, web/mobile clients, hosting mod files (we publish recipes; GameBanana hosts the mods).

## Why these choices

Read these BEFORE making non-trivial changes:
- **`../grimoire/docs/social-architecture.md`** — full architecture: schema, API surface, auth flow, rate limiting, moderation, costs, risks, roadmap
- **`../grimoire/docs/social-architecture-decisions.md`** — 15 ADRs, each with context, tradeoffs, and alternatives considered

The ADRs are append-only. If you change a load-bearing decision, write a new ADR that supersedes the old one — don't edit the existing one.

## Tech stack

- **Cloudflare Workers** + **Hono 4** for HTTP routing
- **D1** (managed SQLite) for users, profiles, likes, reports
- **KV** for session tokens (30-day TTL)
- **Durable Objects** for per-user arbitrary-window rate gates
- **Cloudflare Rate Limit API binding** for high-frequency throttles
- **Zod** for request/response validation; same schemas exported for client reuse
- **TypeScript 5** strict; ES2022 modules
- **wrangler 3** for local dev + deploy
- **pnpm** for package management

## Project structure

```
src/
  index.ts              Hono app entry; mounts /v1/* routes
  env.ts                Bindings type (DB, SESSIONS, RL, DO) + AuthedUser/Variables
  middleware/
    auth.ts             optionalAuth (hydrates c.var.user) | requireAuth | requireAdmin
    rateLimit.ts        rateLimitOrFail (RL API) | checkPublishWindow (DO)
  routes/
    auth.ts             /v1/auth/steam/{begin,callback} + /v1/auth/logout
    me.ts               GET /v1/me + DELETE /v1/me (account deletion)
    profiles.ts         CRUD: list, detail, publish, soft-delete
    likes.ts            POST/DELETE /v1/profiles/:id/like
    reports.ts          POST /v1/profiles/:id/report
  auth/
    steamOpenID.ts      Hand-rolled OpenID 2.0 verifier (Workers-compatible)
  db/
    queries.ts          ID generation + user-side query helpers
  do/
    PublishWindowDO.ts  Per-user gate: publish 1/10min, report 5/day
  shared/
    schemas.ts          Zod wire-format (will become @grimoire/social-types)
migrations/
  0001_initial.sql      Initial schema
wrangler.toml           Worker config (D1, KV, RL, DO bindings)
```

## Dev commands

```bash
pnpm install                                         # Install dependencies
pnpm exec wrangler login                             # First time: auth with Cloudflare
pnpm exec wrangler d1 create grimoire-social         # Create DB; paste id into wrangler.toml
pnpm exec wrangler kv namespace create SESSIONS      # Create KV; paste id into wrangler.toml
pnpm db:migrate:local                                # Apply migrations to local D1
pnpm db:migrate:remote                               # Apply migrations to prod D1
pnpm dev                                             # Local Worker on http://localhost:8787
pnpm typecheck                                       # tsc --noEmit
pnpm deploy                                          # Ship to Cloudflare
pnpm secret:steam-key                                # Set STEAM_API_KEY (interactive)
pnpm secret:admin-token                              # Set ADMIN_TOKEN (interactive)
```

## Architecture in one paragraph

Hono routes mounted under `/v1/*`. Every request runs `optionalAuth` middleware that hydrates `c.var.user` from a `Bearer <session>` token via KV lookup. Routes that need auth use `requireAuth`; admin routes (none yet) use `requireAdmin` against `ADMIN_TOKEN`. Writes go through D1 with denormalized counters (`like_count`); rate-limited actions check either the Cloudflare Rate Limit API (10s/60s windows only — `LIKE_RL`, `AUTH_RL`) or the `PublishWindowDO` Durable Object (arbitrary windows — publish 1/10min, report 5/day). The portable profile blob is stored gzipped inline in `published_profiles.profile_blob` (~1 KB) — no R2.

## Conventions you MUST follow

These rules exist because something specific went wrong (or would have) without them. Don't relax them silently.

### API versioning

- **All routes are prefixed with `/v1/`.** Never break v1 — additive changes only (new optional fields, new endpoints). Breaking changes go to `/v2/` mounted alongside.
- The Electron client ships in releases that may stay installed for years and may not auto-update. A breaking server change bricks installed clients.
- New optional request fields: fine. New response fields: fine. Removing a field, renaming, changing types, or repurposing a field's meaning: never.

### Validation

- **Server validates every inbound body with Zod from `src/shared/schemas.ts`.** No exceptions.
- **Never trust client-supplied derived fields.** When publishing, recompute `has_nsfw`, `mod_count`, `primary_hero` server-side from the decoded portable profile. The client may lie or be out of date.
- Cap blob size after decoding (currently 256 KB). Cap title (80 chars) and description (1000 chars) lengths.

### Migrations

- **Append-only.** Numbered SQL files in `migrations/`. Never edit a shipped migration; always add a new one.
- Use `wrangler d1 migrations create grimoire-social <name>` to scaffold.
- Schema changes that affect the wire format must coordinate with the client — bump `src/shared/schemas.ts` in the same PR.

### Rate limiting

- **Cloudflare Rate Limit API `period` must be `10` or `60` seconds.** This is a hard runtime constraint, verified from Cloudflare docs. If you need a longer window, you MUST use the `PublishWindowDO` (or add a similar DO).
- Don't try to compose two RL bindings to fake a longer window; it's gameable.
- KV is eventually consistent and is NOT suitable for rate limiting that must be cross-colo strict (a user can race two requests through different POPs).

### Identity

- The user PK is a synthetic `users.id` (`usr_<random>`), NOT the Steam ID. Steam ID is a credential row in `identity_credentials`.
- This exists so we can add Discord/GitHub OAuth later without a schema migration.
- When adding a new auth provider, add an `IdentityProvider` implementation; never special-case Steam in route logic.

### Sessions and tokens

- Sessions live in KV with `expirationTtl` matching `SESSION_TTL_SECONDS` (30 days).
- Tokens are 32 random bytes hex-encoded (256 bits of entropy). Don't shorten.
- The session token is returned to the Electron app via a `grimoire://` redirect URL the main process intercepts. **The renderer must never see the token.** Same pattern as the existing API key handling in `../grimoire`.
- Logout is `await c.env.SESSIONS.delete(token)`. Account deletion (DELETE `/v1/me`) deletes only the current session token; other live sessions for that user expire via TTL (we can't enumerate KV by value).

### Account deletion semantics (ADR-014)

- Hard-delete the `users` row (cascades to `identity_credentials` via FK).
- Hard-delete the user's `likes` rows AND decrement `like_count` on every affected profile (the trigger isn't there; do it in the same `batch()`).
- Soft-delete the user's `published_profiles` (set `deleted_at`).
- Mark their open `reports` as `resolution = 'reporter_deleted'`.
- This asymmetry is deliberate: identity is gone, but published artifacts stay so other users' import history remains coherent.

### Read-after-write

- D1 is regionally replicated; reads from non-primary regions may briefly miss writes.
- `POST /v1/profiles` returns the **full created row** so the client can prepend optimistically and skip a refetch.
- `POST/DELETE /v1/profiles/:id/like` returns the new `like_count` and `viewer_has_liked` for the same reason.

### Error responses

- Always JSON: `{ "error": string, "issues"?: unknown }`.
- Validation failures use `400` with the Zod-flattened issues in `issues`.
- Never expose stack traces or internal error messages to the client.

### Free-tier ceiling

- D1 free tier hard-stops at **100K writes/day**. This is a cliff, not throttling.
- Watch the trajectory; pre-emptively upgrade to Workers Paid before any high-traffic share (Discord post, Reddit thread).
- Show a graceful "service is busy, try again later" toast on `5xx` publish/like — never a generic error.

## Known TODOs (load-bearing)

These are scaffolded but not production-ready. Address before public launch.

1. **Admin CLI.** Not in this repo yet. Will be a small Node script hitting the API with `ADMIN_TOKEN` for `list-reports`, `delete-profile`, `ban-user`, `feature-profile`.
2. **Pre-launch seed.** Hand-build 10-20 featured profiles before opening signups; without them the Discover feed is empty and dies on first impression (ADR-012).
3. **GameBanana mod-revalidation cron.** Phase 1.5: weekly job marks profiles whose mods got deleted/archived upstream.
4. **Hero list drift.** Schemas are now consolidated in `packages/social-types/` (ADR-015 done). The hero roster in `src/portable/inferHero.ts` is still duplicated with `../grimoire/src/lib/lockerUtils.ts`. Decide whether it belongs in `@grimoire/social-types` (it isn't wire format) or its own package — for now, when a new Deadlock hero ships, update both files in the same change.

## Wrangler config gotchas

- The `[[migrations]]` block in `wrangler.toml` with `new_sqlite_classes = ["PublishWindowDO"]` is **mandatory** for the DO to deploy. If you add a new DO class, add it to a new `[[migrations]]` entry — DO migrations are append-only too.
- `compatibility_flags = ["nodejs_compat"]` is set in case a future dependency reaches for a Node builtin. We don't depend on it today.
- D1 IDs and KV IDs in `wrangler.toml` are environment-specific. Don't commit real prod IDs to a public repo without thinking it through (they're not secrets per se but they identify your infra).

## What this project is NOT

- It is NOT a general social network framework. Don't generalize for hypothetical other games or use cases.
- It is NOT a CDN for mod files. Mods stay on GameBanana; we publish recipes.
- It is NOT a moderation platform. We rely on structural friction (Steam-only login, rate limits, NSFW flags from GameBanana) plus a manual report queue. Don't build automated content classifiers.
- It is NOT bound to TypeScript or Hono forever, but those are the choices for now and changing them is a real decision (write an ADR).

## Privacy posture

The Grimoire desktop app is offline-first with zero telemetry. This service is the explicit social opt-in:

- No background calls from the client; all requests are user-initiated (open Discover, click Publish, click Like)
- Only data stored: Steam ID (as a credential), display name + avatar (cached from Steam), published profile metadata + blob, likes, reports
- No analytics, no tracking pixels, no third-party integrations
- Account deletion path (DELETE `/v1/me`) is non-negotiable

## No tests yet

Matches Grimoire's own posture (`../grimoire/CLAUDE.md`). Quality relies on TypeScript strict mode and Zod validation. Add tests when the surface stabilizes — start with the OpenID verifier and the publish flow, since those have the most non-trivial logic.
