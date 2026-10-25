import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { optionalAuth } from '../src/middleware/auth.ts';
import { profileRoutes } from '../src/routes/profiles.ts';
import { UpdateProfileResponse } from '../packages/social-types/src/schemas.ts';

const app = new Hono();
app.use('*', optionalAuth);
app.route('/v1/profiles', profileRoutes);

const mod = (name, nsfw = false) => ({
  source: 'gamebanana', ref: { submissionId: 123, fileId: 456 },
  enabled: true, priority: 0,
  hint: { name, nsfw, thumbnailUrl: `https://images.gamebanana.com/${name}.png` },
});
const portable = (mods) => ({
  format: 'mod-profile', schemaVersion: '1.0', game: { steamAppId: 1422450 },
  exportedAt: '2026-10-25T00:00:00Z', exportedBy: { tool: 'Grimoire', version: '1.34.0' },
  profile: { name: 'Loadout' }, mods,
});
const encode = (value) => `mp1:${gzipSync(JSON.stringify(value)).toString('base64url')}`;

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  db.exec(`INSERT INTO users (id, display_name, created_at) VALUES
    ('owner', 'Owner', 1), ('voter', 'Voter', 1);
    INSERT INTO published_profiles
      (id, owner_user_id, title, description, has_nsfw, mod_count, profile_blob,
       like_count, is_featured, created_at, updated_at, thumbnail_urls, heroes, primary_hero)
    VALUES ('original', 'owner', 'Original', 'Description', 0, 1, X'00', 2, 1, 100, 100,
      '["https://example.com/old.png"]', '["haze"]', 'haze');
    INSERT INTO likes VALUES ('original', 'owner', 100), ('original', 'voter', 100);`);
  db.prepare('UPDATE published_profiles SET profile_blob = ?').run(gzipSync(JSON.stringify(portable([mod('Haze')]))));

  // Execute the production route SQL against SQLite; only the D1 API wrapper
  // and remote KV/DO bindings are substituted.
  const DB = {
    prepare(sql) {
      const statement = db.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first(column) {
          const row = statement.get(...args);
          if (!row) return null;
          for (const key of Object.keys(row)) {
            if (row[key] instanceof Uint8Array) row[key] = Uint8Array.from(row[key]).buffer;
          }
          return column ? row[column] : row;
        },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: statement.run(...args) }; },
      };
    },
  };
  const gate = { calls: 0, deny: false, beforeReturn: () => {} };
  const env = {
    DB,
    SESSIONS: { async get(token) { return { user_id: token, exp: 9999999999 }; } },
    PUBLISH_WINDOW: {
      idFromName(id) { return id; },
      get() { return { async fetch(url) {
        assert.equal(new URL(url).searchParams.get('action'), 'publish');
        gate.calls++;
        gate.beforeReturn();
        return new Response(null, { status: gate.deny ? 429 : 200, headers: { 'Retry-After': '120' } });
      } }; },
    },
  };
  const request = (body, { token = 'owner', id = 'original', method = 'PUT', path = '/contents' } = {}) =>
    app.request(`/v1/profiles/${id}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }, env);
  const row = () => db.prepare('SELECT * FROM published_profiles WHERE id = ?').get('original');
  return { db, env, gate, request, row };
}

test('replacement preserves link, votes and publication date, and refreshes GET/list metadata', async (t) => {
  const f = fixture(t);
  const share_code = encode(portable([mod('Abrams'), mod('Abrams', true)]));
  const res = await f.request({ share_code, title: 'Updated', description: null, mod_count: 999, has_nsfw: false });
  assert.equal(res.status, 200);
  const result = UpdateProfileResponse.parse(await res.json());
  assert.equal(result.id, 'original');
  assert.equal(result.like_count, 2);
  assert.equal(result.created_at, 100);
  assert.equal(result.is_featured, true);
  assert.equal(result.viewer_has_liked, null);
  assert.equal(result.share_code, share_code);
  assert.equal(result.mod_count, 2);
  assert.equal(result.has_nsfw, true);
  assert.equal(result.primary_hero, 'Abrams');
  assert.deepEqual(result.heroes, ['Abrams']);
  assert.deepEqual(result.thumbnail_urls, ['https://images.gamebanana.com/Abrams.png']);
  assert.equal(result.description, null);
  assert.ok(result.updated_at > 100);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM likes').get().n, 2);
  const detail = await (await app.request('/v1/profiles/original', {}, f.env)).json();
  assert.equal(detail.share_code, share_code);
  const list = await (await app.request('/v1/profiles?sort=top', {}, f.env)).json();
  assert.equal(list.profiles[0].mod_count, 2);
  assert.equal(list.profiles[0].like_count, 2);
  assert.equal(f.gate.calls, 1);
});

test('content-only replacement retains text and clears obsolete hero/thumbnail/NSFW metadata', async (t) => {
  const f = fixture(t);
  const res = await f.request({ share_code: encode(portable([{ ...mod('Utility'), hint: {} }])) });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.title, 'Original');
  assert.equal(result.description, 'Description');
  assert.equal(result.primary_hero, null);
  assert.equal(result.has_nsfw, false);
  assert.deepEqual(result.heroes, []);
  assert.deepEqual(result.thumbnail_urls, []);
});

for (const [label, options, expected] of [
  ['anonymous', { token: '' }, 401],
  ['another owner', { token: 'voter' }, 403],
  ['missing post', { id: 'missing' }, 404],
]) test(`rejects ${label} without writes or cooldown consumption`, async (t) => {
  const f = fixture(t);
  const before = f.row();
  assert.equal((await f.request({ share_code: encode(portable([mod('Abrams')])) }, options)).status, expected);
  assert.deepEqual(f.row(), before);
  assert.equal(f.gate.calls, 0);
});

test('rejects a deleted post', async (t) => {
  const f = fixture(t);
  f.db.exec('UPDATE published_profiles SET deleted_at = 200');
  assert.equal((await f.request({ share_code: encode(portable([mod('Abrams')])) })).status, 404);
  assert.equal(f.gate.calls, 0);
});

for (const [label, body] of [
  ['missing share code', { title: 'Text only' }],
  ['unsupported prefix', { share_code: 'mp2:abc' }],
  ['invalid base64', { share_code: 'mp1:***' }],
  ['invalid gzip', { share_code: 'mp1:YWJj' }],
  ['invalid portable format', { share_code: encode({ format: 'wrong' }) }],
  ['empty mods', { share_code: encode(portable([])) }],
  ['too many mods', { share_code: encode(portable(Array.from({ length: 101 }, () => mod('Abrams')))) }],
  ['oversized request', { share_code: `mp1:${'a'.repeat(65536)}` }],
  ['inflated size cap', { share_code: encode({ ...portable([mod('Abrams')]), padding: 'x'.repeat(300000) }) }],
]) test(`rejects ${label} before writes or cooldown consumption`, async (t) => {
  const f = fixture(t);
  const before = f.row();
  assert.equal((await f.request(body)).status, 400);
  assert.deepEqual(f.row(), before);
  assert.equal(f.gate.calls, 0);
});

test('cooldown blocks replacement without changing the post', async (t) => {
  const f = fixture(t);
  f.gate.deny = true;
  const before = f.row();
  const res = await f.request({ share_code: encode(portable([mod('Abrams')])) });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '120');
  assert.deepEqual(f.row(), before);
});

test('text-only PATCH retains its behavior and does not consume the publish gate', async (t) => {
  const f = fixture(t);
  const before = f.row();
  const res = await f.request({ title: 'Renamed', description: '' }, { method: 'PATCH', path: '' });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.title, 'Renamed');
  assert.equal(result.description, null);
  assert.equal(result.like_count, 2);
  assert.deepEqual(f.row().profile_blob, before.profile_blob);
  assert.equal(f.gate.calls, 0);
});

test('returns the current like count when a vote arrives during validation', async (t) => {
  const f = fixture(t);
  f.gate.beforeReturn = () => f.db.exec("UPDATE published_profiles SET like_count = 3 WHERE id = 'original'");
  const res = await f.request({ share_code: encode(portable([mod('Abrams')])) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).like_count, 3);
  assert.equal(f.row().like_count, 3);
});

test('does not report success if the post is deleted during validation', async (t) => {
  const f = fixture(t);
  const before = f.row();
  f.gate.beforeReturn = () => f.db.exec("UPDATE published_profiles SET deleted_at = 200 WHERE id = 'original'");
  const res = await f.request({ share_code: encode(portable([mod('Abrams')])) });
  assert.equal(res.status, 404);
  assert.deepEqual(f.row().profile_blob, before.profile_blob);
});
