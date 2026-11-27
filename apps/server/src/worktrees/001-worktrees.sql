CREATE TABLE projects (
  id TEXT PRIMARY KEY, repository TEXT NOT NULL, target TEXT NOT NULL,
  writable INTEGER NOT NULL, commands TEXT NOT NULL
);
CREATE TABLE trees (
  id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), task TEXT, kind TEXT NOT NULL,
  branch TEXT NOT NULL, base TEXT NOT NULL, sha TEXT, status TEXT NOT NULL,
  snapshot TEXT NOT NULL, conflicts TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE publications (
  tree TEXT NOT NULL REFERENCES trees(id), sha TEXT NOT NULL, PRIMARY KEY (tree, sha)
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, tree TEXT NOT NULL REFERENCES trees(id), kind TEXT NOT NULL,
  sha TEXT NOT NULL, target TEXT NOT NULL, name TEXT, command TEXT,
  status TEXT NOT NULL, result TEXT
);
