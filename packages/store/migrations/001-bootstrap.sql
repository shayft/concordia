-- 创建迁移历史；业务表由后续阶段按需增加。
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
) STRICT;
