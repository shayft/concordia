-- Application-wide accounts survive approval changes, workspace switches and restarts.
CREATE TABLE budget_limits (
  scope TEXT NOT NULL, id TEXT NOT NULL, max_calls INTEGER, max_tokens INTEGER, max_concurrent INTEGER,
  PRIMARY KEY (scope, id)
) STRICT;
CREATE TABLE budget_usage (
  scope TEXT NOT NULL, id TEXT NOT NULL, calls INTEGER NOT NULL, tokens INTEGER NOT NULL, active INTEGER NOT NULL,
  PRIMARY KEY (scope, id)
) STRICT;
CREATE TABLE budget_calls (
  id TEXT PRIMARY KEY, scopes TEXT NOT NULL, estimated INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  total_tokens INTEGER, started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL
) STRICT;
ALTER TABLE members ADD COLUMN reports_to TEXT GENERATED ALWAYS AS (json_extract(document,'$.reportsTo')) VIRTUAL
  REFERENCES members(id) ON DELETE RESTRICT;
