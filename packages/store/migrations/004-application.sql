CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
) STRICT;
CREATE UNIQUE INDEX one_selected_workspace ON workspaces(active) WHERE active=1;
CREATE TABLE cli_sessions (binding TEXT PRIMARY KEY, session TEXT NOT NULL) STRICT;
CREATE TABLE plan_requests (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL, member TEXT NOT NULL, connection TEXT NOT NULL,
  started INTEGER NOT NULL, status TEXT NOT NULL, finished INTEGER
) STRICT;
