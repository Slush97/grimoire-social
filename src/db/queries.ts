// Typed D1 query helpers. Keep all SQL in this file so the route code stays
// readable and we can audit indexes against actual queries in one place.

import type { Env } from '../env';

// ---------- ID generation ----------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newUserId(): string {
  return `usr_${randomId(12)}`;
}

export function newProfileId(): string {
  return randomId(8);
}

// ---------- Users ----------

export interface UserRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: number;
  banned_at: number | null;
}

export async function findUserBySteamId(env: Env, steamid64: string): Promise<UserRow | null> {
  return env.DB
    .prepare(
      `SELECT u.id, u.display_name, u.avatar_url, u.created_at, u.banned_at
         FROM users u
         JOIN identity_credentials c ON c.user_id = u.id
        WHERE c.provider = 'steam' AND c.provider_user_id = ?`
    )
    .bind(steamid64)
    .first<UserRow>();
}

export async function createUserWithSteamCredential(
  env: Env,
  args: { steamid64: string; display_name: string; avatar_url: string | null }
): Promise<UserRow> {
  const id = newUserId();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?)`
    ).bind(id, args.display_name, args.avatar_url, now),
    env.DB.prepare(
      `INSERT INTO identity_credentials (provider, provider_user_id, user_id, linked_at)
       VALUES ('steam', ?, ?, ?)`
    ).bind(args.steamid64, id, now),
  ]);
  return {
    id,
    display_name: args.display_name,
    avatar_url: args.avatar_url,
    created_at: now,
    banned_at: null,
  };
}

export async function refreshUserProfile(
  env: Env,
  userId: string,
  args: { display_name: string; avatar_url: string | null }
): Promise<void> {
  await env.DB
    .prepare(`UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?`)
    .bind(args.display_name, args.avatar_url, userId)
    .run();
}

// ---------- Profiles ----------
// Route handlers will own SQL for these once we land Task #6 in detail; the
// scaffolding stubs there reference these helpers as TODO. Putting the
// signatures here documents the surface.

export interface ProfileRow {
  id: string;
  owner_user_id: string;
  title: string;
  description: string | null;
  has_nsfw: number;
  mod_count: number;
  primary_hero: string | null;
  like_count: number;
  is_featured: number;
  created_at: number;
  updated_at: number;
}
