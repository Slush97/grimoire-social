-- Surface mod thumbnail URLs on the list/detail/me responses so the client
-- can render image-led profile cards without decoding share_code per row.
-- Stores up to 4 GameBanana thumbnail URLs as JSON, extracted at publish time
-- from the portable profile's mod hints. Existing rows stay NULL until they
-- are re-published; the client falls back to a placeholder.
ALTER TABLE published_profiles ADD COLUMN thumbnail_urls TEXT;
