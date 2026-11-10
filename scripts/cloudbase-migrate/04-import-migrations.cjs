const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const out = process.argv[2];
const rows = JSON.parse(fs.readFileSync(path.join(out, 'data', '_prisma_migrations.json'), 'utf8'));

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const cols = ['id','checksum','finished_at','migration_name','logs','rolled_back_at','started_at','applied_steps_count'];
const sql = 'INSERT INTO "_prisma_migrations" (' + cols.map(c => '"' + c + '"').join(',') + ') VALUES ' +
  rows.map(r => '(' + cols.map(c => lit(r[c])).join(',') + ')').join(',');

fs.writeFileSync('.mig-migrations.sql', sql);
console.log('bytes:', sql.length);
