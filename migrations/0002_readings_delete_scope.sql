-- Adds the readings:delete scope (reading-lite-qmy). SQLite cannot alter a
-- CHECK constraint in place, so the table is rebuilt with the expanded scope
-- list and existing grants copied across.
CREATE TABLE api_token_scopes_new (
  token_id TEXT NOT NULL REFERENCES api_tokens(id),
  scope TEXT NOT NULL CHECK (scope IN ('readings:read', 'readings:write', 'readings:import', 'readings:delete')),
  PRIMARY KEY (token_id, scope)
);

INSERT INTO api_token_scopes_new (token_id, scope)
SELECT token_id, scope FROM api_token_scopes;

DROP TABLE api_token_scopes;

ALTER TABLE api_token_scopes_new RENAME TO api_token_scopes;
