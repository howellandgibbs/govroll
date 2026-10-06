-- Trigram index on Bill."displayTitle", the title set on ~97% of bills.
--
-- Keyword search ORs a tsvector match with pg_trgm `%` on four title
-- columns. popularTitle, shortTitle and title had GIN trigram indexes
-- (20260419184230); displayTitle didn't, and one unindexed branch turns
-- the whole OR into a sequential scan computing trigram similarity on
-- every bill. Live-only searches hid that behind the momentumTier index,
-- but searches across all tiers (the header typeahead, and every /bills
-- search now) took ~5s. With all four indexed, the match plans as a
-- BitmapOr over matching rows.
CREATE INDEX IF NOT EXISTS "Bill_displayTitle_trgm_idx"
  ON "Bill" USING GIN ("displayTitle" gin_trgm_ops);
