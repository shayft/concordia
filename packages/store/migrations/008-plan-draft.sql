CREATE TABLE plan_draft (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  text TEXT NOT NULL
) STRICT;
INSERT INTO plan_draft VALUES (1, 0, '');
