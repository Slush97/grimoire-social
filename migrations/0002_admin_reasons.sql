-- Moderator audit fields. Captures the free-text "why" admins provide via
-- the CLI's --reason flag so we don't lose history between actions.
--
-- All three columns are nullable: existing rows have no recorded reason, and
-- ad-hoc actions taken without a reason are still valid.

ALTER TABLE reports             ADD COLUMN resolution_reason TEXT;
ALTER TABLE users               ADD COLUMN ban_reason        TEXT;
ALTER TABLE published_profiles  ADD COLUMN deletion_reason   TEXT;
