CREATE TABLE conflict_issues (
  tree TEXT PRIMARY KEY REFERENCES trees(id),
  recipients TEXT NOT NULL
);
