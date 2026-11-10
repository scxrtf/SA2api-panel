/**
 * 把 prisma/migrations 下的全部 migration.sql 按版本顺序拼接成一个
 * CloudBase PG 迁移文件，写到 cloudbase/migrations/<ts>_import_prisma_schema.sql
 * 供 `cloudbase db pg migration up` 应用。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const srcDir = path.join(root, 'prisma', 'migrations');
const dstDir = path.join(root, 'cloudbase', 'migrations');
fs.mkdirSync(dstDir, { recursive: true });

const versions = fs.readdirSync(srcDir)
  .filter(d => /^\d{14}_/.test(d) && fs.existsSync(path.join(srcDir, d, 'migration.sql')))
  .sort();

const parts = [];
for (const v of versions) {
  const sql = fs.readFileSync(path.join(srcDir, v, 'migration.sql'), 'utf8');
  parts.push('-- >>> prisma migration ' + v + '\n' + sql.trim() + '\n');
}

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const out = path.join(dstDir, ts + '_import_prisma_schema.sql');
fs.writeFileSync(out, parts.join('\n'));
console.log('written ' + out + ' from ' + versions.length + ' prisma migrations');
