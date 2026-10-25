# Published profile content updates

`PUT /v1/profiles/:id/contents` lets an authenticated owner replace an existing
post's portable profile. The body requires `share_code` and accepts optional
`title` and `description`, with the same limits and clearing semantics as PATCH.

The Worker validates the portable profile before consuming the existing per-user
publish cooldown. It recomputes mod count, NSFW status, primary hero, hero list,
and thumbnail URLs, then writes the blob and metadata in one UPDATE. Empty mod
lists and profiles above the 100-mod cap are rejected.

The row ID, likes, featured status, and original publication date are preserved.
The response is a full `ProfileDetail`; clients can replace cached metadata
without an immediate refetch. `viewer_has_liked` is null, so clients retain their
known viewer state. Existing imports remain local snapshots.

Deploy this Worker and make its shared types available before building and
shipping the desktop update. An older Worker returns 404 for this endpoint,
preventing a false success from an ignored share-code field. Existing text-only
PATCH requests retain their behavior. No database migration is required.

Verification: `pnpm typecheck` and `pnpm test` on Node 22.13 or newer. The route
tests use an in-memory SQLite database with the real migrations and exercise
the Hono routes with local bindings. They do not contact the deployed Worker.
