# grimoire-social

Backend service for Grimoire profile sharing and likes. Cloudflare Worker + D1 + KV + Durable Objects.

See `../grimoire/docs/social-architecture.md` and `../grimoire/docs/social-architecture-decisions.md` for the full design.

## First-time setup

Requires Node.js 24+ and pnpm 12 (`package.json` pins pnpm 12 to match `grimoire`).

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

## Nix

`flake.nix` provides a devShell with the toolchain above (`nix develop`).
On NixOS also enable `programs.nix-ld.enable = true;` so the npm-fetched
`workerd` binary runs. Setup inside the shell is unchanged.

## Dev loop

```bash
cp .dev.vars.example .dev.vars   # fill in STEAM_API_KEY, ADMIN_TOKEN
pnpm dev                         # local Worker on http://localhost:8787
pnpm typecheck                   # tsc --noEmit (Worker + cli/)
```

`.dev.vars` overrides `[vars]` from `wrangler.toml` for `wrangler dev` only — it lets you point `STEAM_REALM` / `STEAM_RETURN_TO` at localhost so Steam's user-side redirect comes back to your machine.

To exercise the API end-to-end with the Electron client at `../grimoire`, set `GRIMOIRE_SOCIAL_BASE_URL=http://localhost:8787` in the client's env before launching it.

## Admin CLI

```bash
export GRIMOIRE_SOCIAL_URL=http://localhost:8787
export GRIMOIRE_SOCIAL_ADMIN_TOKEN=$ADMIN_TOKEN   # whatever you put in .dev.vars
pnpm admin list-reports
pnpm admin feature-profile <profile_id>
pnpm admin delete-profile <profile_id> --reason="spam"
pnpm admin ban-user <user_id> --reason="repeat offender"
```

## Publishing `@grimoire/social-types`

`packages/social-types` holds the shared Zod wire-format schemas and hero roster consumed by both this Worker and the `grimoire` desktop app.

`grimoire` consumes `@grimoire/social-types` as a pinned tarball attached to GitHub Releases on this repo, so desktop contributors do not need to clone `grimoire-social`. When you change anything under `packages/social-types/src/`:

1. Bump `"version"` in `packages/social-types/package.json` (e.g. `0.1.0` -> `0.2.0`).
2. Merge to `main`.
3. Tag and push `types-vX.Y.Z` (must match `package.json`):
   ```bash
   git tag types-v0.2.0
   git push origin types-v0.2.0
   ```
4. The `Release @grimoire/social-types` workflow builds `dist/`, packs `grimoire-social-types-X.Y.Z.tgz`, and attaches it to the GitHub Release.
5. Update the `@grimoire/social-types` URL in `grimoire/package.json` and run `pnpm install` there.

To test local `packages/social-types` edits inside `grimoire` before tagging a release, run `pnpm build:types` here and link the local package inside `grimoire`:

```bash
pnpm link ../grimoire-social/packages/social-types
```

When you are done, remove the local link in `grimoire` with `pnpm unlink @grimoire/social-types` (note that `pnpm link` writes an override to `pnpm-workspace.yaml`, so `pnpm install` alone does not remove it).

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
    admin.ts            /v1/admin/* moderation surface
  auth/
    steamOpenID.ts      Hand-rolled OpenID 2.0 verifier (Workers-compatible)
  db/
    queries.ts          Typed D1 query helpers
  do/
    PublishWindowDO.ts  Per-user 10-min publish gate
  portable/
    portableProfile.ts  Workers-compatible parser for mp1: share codes
    inferHero.ts        Hero-from-title matcher (port of lockerUtils.ts)
  shared/
    schemas.ts          Re-export shim for packages/social-types/
packages/
  social-types/         Shared Zod wire-format + hero roster published via `types-v*` releases (ADR-015)
cli/
  admin.ts              grimoire-social-admin CLI (run via `pnpm admin <cmd>`)
migrations/
  0001_initial.sql      Initial schema
  0002_admin_reasons.sql Moderator audit columns
```

## Conventions

- All routes prefixed with `/v1/`. Never break v1 — additive changes only. Breaking changes go to `/v2/` alongside.
- Server validates every inbound body with Zod from `src/shared/schemas.ts`. Never trust client-supplied derived fields (`has_nsfw`, `mod_count`); recompute server-side.
- Migrations are append-only numbered SQL files. Never edit a shipped migration.
- No tests yet (matches grimoire's own posture). Add them when the surface stabilizes.
