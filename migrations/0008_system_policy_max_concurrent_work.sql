-- s1k.9.2: global processing concurrency lives on the singleton system_policy
-- row. Placeholder only (GLOBAL_PLACEHOLDER_CONCURRENCY = 3); production
-- economics are s1k.9.5. paid_work_enabled stays unused until s1k.9.4.
ALTER TABLE system_policy
  ADD COLUMN max_concurrent_work INTEGER NOT NULL DEFAULT 3;
