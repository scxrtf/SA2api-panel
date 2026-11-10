/**
 * 从源 Prisma Postgres 导出完整数据库快照（schema + data）到本地目录。
 * 使用 REPEATABLE READ 事务保证快照一致性。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const out = process.argv[2];
if (!out) { console.error('usage: node 01-export.cjs <outDir>'); process.exit(1); }
fs.mkdirSync(path.join(out, 'data'), { recursive: true });
fs.mkdirSync(path.join(out, 'schema'), { recursive: true });

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const tables = (await c.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  )).rows.map(r => r.tablename);

  const columns = (await c.query(
    "SELECT table_name, column_name, ordinal_position, data_type, udt_name, " +
    "is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale " +
    "FROM information_schema.columns WHERE table_schema='public' " +
    "ORDER BY table_name, ordinal_position"
  )).rows;

  const constraints = (await c.query(
    "SELECT conname, conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def, contype " +
    "FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conname"
  )).rows;

  const indexes = (await c.query(
    "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname"
  )).rows;

  const sequences = (await c.query(
    "SELECT sequence_name, data_type, start_value, minimum_value, maximum_value, increment, cycle_option " +
    "FROM information_schema.sequences WHERE sequence_schema='public' ORDER BY sequence_name"
  )).rows;

  const functions = (await c.query(
    "SELECT proname AS name, pg_get_functiondef(oid) AS def " +
    "FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' ORDER BY proname"
  )).rows;

  const triggers = (await c.query(
    "SELECT tgname AS name, tgrelid::regclass::text AS table_name, pg_get_triggerdef(oid) AS def " +
    "FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname"
  )).rows;

  const manifest = { exportedAt: new Date().toISOString(), tables: {}, sha256: {} };

  for (const t of tables) {
    const rows = (await c.query('SELECT * FROM "' + t + '"')).rows;
    const file = path.join(out, 'data', t + '.json');
    const body = JSON.stringify(rows);
    fs.writeFileSync(file, body);
    manifest.tables[t] = { rows: rows.length };
    manifest.sha256[t] = crypto.createHash('sha256').update(body).digest('hex');
    console.log('exported ' + t + ': ' + rows.length + ' rows');
  }

  const write = (name, obj) => fs.writeFileSync(path.join(out, 'schema', name), JSON.stringify(obj, null, 2));
  write('tables.json', tables);
  write('columns.json', columns);
  write('constraints.json', constraints);
  write('indexes.json', indexes);
  write('sequences.json', sequences);
  write('functions.json', functions);
  write('triggers.json', triggers);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  await c.query('ROLLBACK');
  await c.end();
  console.log('DONE ' + JSON.stringify({ tables: tables.length, out }));
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
