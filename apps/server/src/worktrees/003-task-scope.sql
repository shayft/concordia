ALTER TABLE trees ADD COLUMN scope TEXT;
CREATE INDEX trees_by_task ON trees(project, scope, task);
