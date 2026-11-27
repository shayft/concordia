CREATE TABLE workflow_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE workflow_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE workflow_wakeups (
  workflow_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  PRIMARY KEY (workflow_id, task_id, version_id)
) WITHOUT ROWID;
