# hash-index (Phase 0 prototype)

Standalone scraper that walks the GameBanana API for Deadlock, downloads every
Mod/Sound file, extracts the VPKs inside, and sha256s them. Output is a local
SQLite database at `data/hash-index.db`.

Lives in `grimoire-social` because this project will eventually own the
canonical hash index (D1 table + `/v1/hashes/*` routes + nightly GitHub
Action). The desktop client (`grimoire/`) is a consumer of that index, not
its host.

The whole point of Phase 0 is to validate the approach (does GameBanana let us
do this politely, how big does the corpus get, how long does a full run take)
before we commit to a D1 schema, an API surface, or a nightly Action.

## Why we want this

Build a `{vpk_sha256 → gamebanana_file_id}` lookup so the desktop client can:

- Recognize a VPK already sitting in `addons/` (even one the user dropped in
  manually before they ever opened Grimoire).
- Skip re-downloading on profile import when the user already has the file.
- Verify post-extract integrity against a canonical hash.

We also opportunistically capture `_sMd5Checksum` (the archive's MD5, supplied
by GameBanana) so resumed runs can skip files we've already processed without
re-downloading anything. Phase 0 validation showed 100% MD5 coverage on real
data.

## Run

```bash
pnpm hash-index                              # full run
pnpm hash-index --max-pages 1 --limit 3      # smoke test
pnpm hash-index --process-only --limit 50    # process more pending; no new discovery
pnpm hash-index --discovery-only             # only populate files table; no downloads
pnpm hash-index --sections Sound             # narrow to one section
```

The script is resumable: kill it with Ctrl-C and re-run; it picks up where it
left off using the local SQLite state.

## Data layout

- `data/hash-index.db` - SQLite (uses Node 22+ stable `node:sqlite`, no native
  build coupling)
- `data/tmp/` - per-file scratch dir (cleaned per file)
- `data/stats-<unix_ts>.json` - run summary

All gitignored.

## Phase plan

- **Phase 0 (this script)**: prove the pipeline works, get a real dataset.
- **Phase 1**: dump SQLite to SQL, `wrangler d1 execute --remote --file=` it
  into a fresh D1 in this project, add read-only `/v1/hashes/lookup` and
  `/v1/hashes/by-gb-file` routes.
- **Phase 2**: nightly GitHub Action running this same script in delta mode,
  posting to a `/v1/hashes/ingest` write endpoint.
