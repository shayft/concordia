CREATE TABLE governance (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session TEXT NOT NULL,
  created INTEGER NOT NULL,
  workspace TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL
) STRICT;
CREATE INDEX governance_workspace ON governance(workspace,seq);
ALTER TABLE budget_calls ADD COLUMN approval_id TEXT REFERENCES governance(id);
ALTER TABLE budget_calls ADD COLUMN outcome TEXT;
CREATE INDEX calls_by_approval ON budget_calls(approval_id);
ALTER TABLE plan_requests ADD COLUMN approval_id TEXT REFERENCES governance(id);
CREATE INDEX plans_by_approval ON plan_requests(approval_id);
CREATE TABLE approved_executions (
  execution TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES governance(id),
  status TEXT NOT NULL
) STRICT;
CREATE INDEX executions_by_approval ON approved_executions(approval_id);
