CREATE TABLE version_sources (
  workspace TEXT NOT NULL, execution TEXT NOT NULL, sha TEXT NOT NULL,
  project TEXT NOT NULL, tree TEXT NOT NULL, PRIMARY KEY(workspace,execution,sha)
) STRICT;
