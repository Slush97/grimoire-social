// Wire format for the v1 HTTP API. Single source of truth shared between
// Worker (validates inbound, types responses) and the Electron client (types
// IPC payloads, validates inbound responses).
//
// ADR-005: v1 is locked. Add fields as optional; never remove or repurpose.
// ADR-015: shared Zod schemas prevent silent client/server drift.

import { z } from 'zod';

// ---------- Primitive shapes ----------

export const UserPublic = z.object({
  id: z.string(),
  display_name: z.string(),
  avatar_url: z.string().url().nullable(),
});
export type UserPublic = z.infer<typeof UserPublic>;

export const ProfileSummary = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  has_nsfw: z.boolean(),
  mod_count: z.number().int().nonnegative(),
  primary_hero: z.string().nullable(),
  like_count: z.number().int().nonnegative(),
  is_featured: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  owner: UserPublic,
  // Up to 4 GameBanana mod thumbnail URLs in publish order; client uses the
  // first for the card hero strip. Optional + nullable so old client builds
  // and pre-migration rows both stay valid (ADR-005 additive-only).
  thumbnail_urls: z.array(z.string()).max(4).nullable().optional(),
  // Every distinct hero inferred from the published profile's mod hints,
  // sorted most-modded-first. primary_hero is always heroes[0] when this
  // has entries. Optional + nullable so pre-migration rows degrade to just
  // primary_hero on the client.
  heroes: z.array(z.string()).max(8).nullable().optional(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const ProfileDetail = ProfileSummary.extend({
  // Base64-encoded gzipped portable profile. Client decompresses and feeds
  // to the existing import pipeline.
  share_code: z.string(),
  // Whether the current authenticated viewer has liked this profile.
  // Null when called unauthenticated.
  viewer_has_liked: z.boolean().nullable(),
});
export type ProfileDetail = z.infer<typeof ProfileDetail>;

// ---------- Auth ----------

export const AuthBeginResponse = z.object({
  redirect_url: z.string().url(),
});
export type AuthBeginResponse = z.infer<typeof AuthBeginResponse>;

export const AuthCallbackResponse = z.object({
  token: z.string(),
  expires_at: z.number().int(),
  user: UserPublic,
});
export type AuthCallbackResponse = z.infer<typeof AuthCallbackResponse>;

// ---------- /me ----------

export const MeResponse = z.object({
  user: UserPublic,
  profiles: z.array(ProfileSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------- Profiles ----------

export const ProfileSort = z.enum(['top', 'new', 'hero', 'featured']);
export type ProfileSort = z.infer<typeof ProfileSort>;

export const ListProfilesQuery = z.object({
  sort: ProfileSort.default('top'),
  hero: z.string().optional(),
  hideNsfw: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
});
export type ListProfilesQuery = z.infer<typeof ListProfilesQuery>;

export const ListProfilesResponse = z.object({
  page: z.number().int(),
  page_size: z.number().int(),
  total: z.number().int(),
  profiles: z.array(ProfileSummary),
});
export type ListProfilesResponse = z.infer<typeof ListProfilesResponse>;

// Publish: client supplies the share code (already validated locally) plus
// title and description. Server re-validates the share code, recomputes
// derived fields (has_nsfw, mod_count, primary_hero), and stores.
export const PublishRequest = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).optional(),
  // mp1:<base64url(gzip(json))> share code; max ~16 KB after decode (validated).
  share_code: z.string().min(1).max(64 * 1024),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

// PublishResponse returns the FULL row so client can optimistically prepend
// to its in-memory list without refetching (D1 read-after-write).
export const PublishResponse = ProfileDetail;
export type PublishResponse = z.infer<typeof PublishResponse>;

// ---------- Likes ----------

export const LikeResponse = z.object({
  profile_id: z.string(),
  like_count: z.number().int().nonnegative(),
  viewer_has_liked: z.boolean(),
});
export type LikeResponse = z.infer<typeof LikeResponse>;

// ---------- Reports ----------

export const ReportRequest = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type ReportRequest = z.infer<typeof ReportRequest>;

// ---------- Errors ----------

export const ErrorResponse = z.object({
  error: z.string(),
  // Optional Zod-style flattened issues for validation failures.
  issues: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
