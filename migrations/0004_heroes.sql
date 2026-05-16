-- Surface every distinct hero referenced by a published profile (not just the
-- modal one). The client renders these as a hero badge row on each card.
-- Stored as JSON array; existing rows stay NULL until they are re-published,
-- and the client falls back to primary_hero alone for those.
ALTER TABLE published_profiles ADD COLUMN heroes TEXT;
