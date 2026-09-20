-- Inbound relationships by target.
--
-- reading_relationships is keyed (tenant_id, source_id, kind, target_id), which
-- answers "what does this reading point at" from the primary key and "what
-- points at this reading" only by scanning the table. The second question has
-- one caller, `ops corpus purge-connections`, and it exists because the
-- foreign key covers the source alone: deleting a reading cascades the
-- relationships it declared and leaves every row that named it as a target.
--
-- Detail reads tolerate a missing target, so this is not a correctness fix. It
-- makes the purge's count and delete an index lookup instead of a sequential
-- scan, which is what the command's own reasoning already claimed.
CREATE INDEX reading_relationships_target
  ON reading_relationships (tenant_id, target_id);
