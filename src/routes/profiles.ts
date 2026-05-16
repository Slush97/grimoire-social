// /v1/profiles
//   GET    /                  - paginated list (sort=top|new|hero|featured)
//   GET    /:id               - detail (includes share_code, viewer_has_liked)
//   POST   /                  - publish; gated by PublishWindow DO
//   DELETE /:id               - owner-only soft delete

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { requireAuth } from '../middleware/auth';
import { checkPublishWindow } from '../middleware/rateLimit';
import {
  ListProfilesQuery,
  PublishRequest,
  type ListProfilesResponse,
  type ProfileDetail,
  type ProfileSummary,
  type PublishResponse,
} from '../shared/schemas';
import { newProfileId } from '../db/queries';
import {
  base64urlDecode,
  base64urlEncode,
  derivePortableMetadata,
  MAX_MODS,
  parsePortableProfile,
  PortableProfileError,
  PORTABLE_PROFILE_SHARE_PREFIX,
} from '../portable/portableProfile';

export const profileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PAGE_SIZE = 20;

profileRoutes.get('/', async (c) => {
  const parsed = ListProfilesQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: 'invalid query', issues: parsed.error.flatten() }, 400);
  }
  const { sort, hero, hideNsfw, page } = parsed.data;
  const offset = (page - 1) * PAGE_SIZE;

  // Build ORDER BY clause. We rely on the partial indexes from migration 0001.
  let orderBy = 'p.like_count DESC, p.created_at DESC';
  if (sort === 'new') orderBy = 'p.created_at DESC';
  if (sort === 'featured') orderBy = 'p.is_featured DESC, p.updated_at DESC';

  const conditions: string[] = ['p.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (sort === 'hero' && hero) {
    conditions.push('p.primary_hero = ?');
    binds.push(hero);
  } else if (sort === 'hero') {
    conditions.push('p.primary_hero IS NOT NULL');
  }
  if (hideNsfw) {
    conditions.push('p.has_nsfw = 0');
  }
  if (sort === 'featured') {
    conditions.push('p.is_featured = 1');
  }
  const where = conditions.join(' AND ');

  const rows = await c.env.DB
    .prepare(
      `SELECT p.id, p.title, p.description, p.has_nsfw, p.mod_count,
              p.primary_hero, p.like_count, p.is_featured,
              p.created_at, p.updated_at,
              u.id AS owner_id, u.display_name AS owner_name, u.avatar_url AS owner_avatar
         FROM published_profiles p
         JOIN users u ON u.id = p.owner_user_id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`
    )
    .bind(...binds, PAGE_SIZE, offset)
    .all<{
      id: string; title: string; description: string | null;
      has_nsfw: number; mod_count: number; primary_hero: string | null;
      like_count: number; is_featured: number;
      created_at: number; updated_at: number;
      owner_id: string; owner_name: string; owner_avatar: string | null;
    }>();

  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM published_profiles p WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();

  const profiles: ProfileSummary[] = rows.results.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    has_nsfw: r.has_nsfw === 1,
    mod_count: r.mod_count,
    primary_hero: r.primary_hero,
    like_count: r.like_count,
    is_featured: r.is_featured === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
    owner: { id: r.owner_id, display_name: r.owner_name, avatar_url: r.owner_avatar },
  }));

  const body: ListProfilesResponse = {
    page,
    page_size: PAGE_SIZE,
    total: total?.n ?? 0,
    profiles,
  };
  return c.json(body);
});

profileRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB
    .prepare(
      `SELECT p.id, p.title, p.description, p.has_nsfw, p.mod_count,
              p.primary_hero, p.like_count, p.is_featured,
              p.created_at, p.updated_at, p.profile_blob,
              u.id AS owner_id, u.display_name AS owner_name, u.avatar_url AS owner_avatar
         FROM published_profiles p
         JOIN users u ON u.id = p.owner_user_id
        WHERE p.id = ? AND p.deleted_at IS NULL`
    )
    .bind(id)
    .first<{
      id: string; title: string; description: string | null;
      has_nsfw: number; mod_count: number; primary_hero: string | null;
      like_count: number; is_featured: number;
      created_at: number; updated_at: number; profile_blob: ArrayBuffer;
      owner_id: string; owner_name: string; owner_avatar: string | null;
    }>();
  if (!row) return c.json({ error: 'not found' }, 404);

  const viewer = c.get('user');
  let viewerHasLiked: boolean | null = null;
  if (viewer) {
    const like = await c.env.DB
      .prepare(`SELECT 1 FROM likes WHERE profile_id = ? AND voter_user_id = ?`)
      .bind(row.id, viewer.id)
      .first();
    viewerHasLiked = like !== null;
  }

  // Re-encode blob to share code: the DB stores the already-gzipped bytes,
  // so we just base64url them and re-add the mp1: prefix.
  const blobBytes = new Uint8Array(row.profile_blob);
  const shareCode = `${PORTABLE_PROFILE_SHARE_PREFIX}${base64urlEncode(blobBytes)}`;

  const detail: ProfileDetail = {
    id: row.id,
    title: row.title,
    description: row.description,
    has_nsfw: row.has_nsfw === 1,
    mod_count: row.mod_count,
    primary_hero: row.primary_hero,
    like_count: row.like_count,
    is_featured: row.is_featured === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owner: { id: row.owner_id, display_name: row.owner_name, avatar_url: row.owner_avatar },
    share_code: shareCode,
    viewer_has_liked: viewerHasLiked,
  };
  return c.json(detail);
});

profileRoutes.post('/', requireAuth, async (c) => {
  const user = c.get('user')!;

  // Per-user 10-minute publish gate (ADR-004).
  const limited = await checkPublishWindow(c, user.id, 'publish');
  if (limited) return limited;

  const body = await c.req.json().catch(() => null);
  const parsed = PublishRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', issues: parsed.error.flatten() }, 400);
  }
  const { title, description, share_code } = parsed.data;

  // Decompress + validate the share code. The parser enforces the inflated
  // 16 KB cap; we also keep the compressed-byte cap below as a cheap upstream
  // gate on storage size.
  if (!share_code.startsWith(PORTABLE_PROFILE_SHARE_PREFIX)) {
    return c.json({ error: 'unsupported share code format' }, 400);
  }
  const blobBytes = base64urlDecode(share_code.slice(PORTABLE_PROFILE_SHARE_PREFIX.length));
  if (blobBytes.byteLength > 16 * 1024) {
    return c.json({ error: 'share code too large' }, 413);
  }

  let portable;
  try {
    portable = await parsePortableProfile(share_code);
  } catch (err) {
    if (err instanceof PortableProfileError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  if (portable.mods.length > MAX_MODS) {
    return c.json({ error: `mod count ${portable.mods.length} exceeds ${MAX_MODS} cap` }, 400);
  }

  const derived = derivePortableMetadata(portable, title);

  const id = newProfileId();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `INSERT INTO published_profiles
         (id, owner_user_id, title, description, has_nsfw, mod_count,
          primary_hero, profile_blob, like_count, is_featured,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
    )
    .bind(
      id, user.id, title, description ?? null,
      derived.has_nsfw ? 1 : 0, derived.mod_count, derived.primary_hero,
      blobBytes, now, now
    )
    .run();

  const response: PublishResponse = {
    id,
    title,
    description: description ?? null,
    has_nsfw: derived.has_nsfw,
    mod_count: derived.mod_count,
    primary_hero: derived.primary_hero,
    like_count: 0,
    is_featured: false,
    created_at: now,
    updated_at: now,
    owner: { id: user.id, display_name: user.display_name, avatar_url: user.avatar_url },
    share_code,
    viewer_has_liked: false,
  };
  return c.json(response, 201);
});

profileRoutes.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const now = Math.floor(Date.now() / 1000);

  const row = await c.env.DB
    .prepare(`SELECT owner_user_id FROM published_profiles WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ owner_user_id: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.owner_user_id !== user.id) return c.json({ error: 'not allowed' }, 403);

  await c.env.DB
    .prepare(`UPDATE published_profiles SET deleted_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();
  return c.body(null, 204);
});

