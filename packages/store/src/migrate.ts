import { openStore } from './index.ts';

const [databasePath, ...extra] = process.argv.slice(2);
if (!databasePath || extra.length > 0) {
  process.stderr.write('用法：pnpm db:migrate <本地数据库文件路径>\n');
  process.exitCode = 2;
} else {
  try {
    const db = openStore(databasePath);
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      process.stdout.write(`SQLite WAL 已启用，数据库版本 ${version}。\n`);
    } finally {
      db.close();
    }
  } catch {
    process.stderr.write('无法迁移数据库，请检查文件版本、本地数据目录权限和磁盘空间。\n');
    process.exitCode = 1;
  }
}
