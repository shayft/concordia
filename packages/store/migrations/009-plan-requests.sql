ALTER TABLE plan_requests ADD COLUMN selected_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plan_requests ADD COLUMN request_key TEXT;
ALTER TABLE plan_requests ADD COLUMN request_hash TEXT;
ALTER TABLE plan_requests ADD COLUMN phase TEXT NOT NULL DEFAULT 'finished';
ALTER TABLE plan_requests ADD COLUMN progress_bytes INTEGER NOT NULL DEFAULT 0 CHECK(progress_bytes >= 0);
ALTER TABLE plan_requests ADD COLUMN result_ref TEXT;
CREATE UNIQUE INDEX plan_request_key ON plan_requests(workspace, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX plan_request_history ON plan_requests(workspace, started DESC);
