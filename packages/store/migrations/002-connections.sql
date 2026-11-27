-- Store the validated document once; generated columns enforce references even on edits.
CREATE TABLE quota_pools (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL CHECK (json_extract(document, '$.id') = id)
) STRICT;
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL CHECK (json_extract(document, '$.id') = id),
  pool_id TEXT GENERATED ALWAYS AS (json_extract(document, '$.poolId')) STORED
    REFERENCES quota_pools(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE catalog_models (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL CHECK (json_extract(document, '$.id') = id),
  connection_id TEXT GENERATED ALWAYS AS (json_extract(document, '$.connectionId')) STORED
    NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  UNIQUE(id, connection_id)
) STRICT;
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL CHECK (json_extract(document, '$.id') = id),
  connection_id TEXT GENERATED ALWAYS AS (json_extract(document, '$.connectionId')) STORED
    NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  model_id TEXT GENERATED ALWAYS AS (json_extract(document, '$.modelId')) STORED,
  FOREIGN KEY(model_id, connection_id) REFERENCES catalog_models(id, connection_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;
