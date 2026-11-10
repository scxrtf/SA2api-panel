/**
 * 用 TC3-HMAC-SHA256 签名直接 HTTPS 调用 tcb.ExecutePGSql，批量导入快照数据。
 * 凭据从命令行参数读，避免写盘。
 * usage: node 03-import.cjs <snapshotDir> <secretId> <secretKey> <token>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const out = process.argv[2];
const credFile = process.argv[3] || '.mig-cred.json';
if (!out || !fs.existsSync(credFile)) {
  console.error('usage: node 03-import.cjs <snapshotDir> [credFile]');
  process.exit(1);
}
const { secretId, secretKey, token } = JSON.parse(fs.readFileSync(credFile, 'utf8'));
const envId = 'democratic-aphid-d2ekz7739861827';
const HOST = 'tcb.tencentcloudapi.com';
const SERVICE = 'tcb';
const VERSION = '2018-06-08';
const ACTION = 'ExecutePGSql';
const REGION = 'ap-shanghai';

const ORDER = [
  'Provider', 'Account', 'AccountState', 'ApiKey', 'ModelCost', 'ModelCooldown',
  'ModelProbe', 'ModelHealthCheck', 'MachineKeyAuthorization', 'Setting',
  'LoginSession', 'StickySession', 'TaskQueueItem', 'UsageEvent', 'RequestLog',
  'BalanceSample', '_prisma_migrations',
];
const BATCH = 200;

const columns = JSON.parse(fs.readFileSync(path.join(out, 'schema', 'columns.json'), 'utf8'));
const colsByTable = {};
for (const c of columns) (colsByTable[c.table_name] ||= []).push(c);

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg, 'utf8').digest(); }

function sign(payload) {
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + HOST + '\n';
  const signedHeaders = 'content-type;host';
  const hashedPayload = sha256hex(payload);
  const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedPayload;
  const scope = date + '/' + SERVICE + '/tc3_request';
  const stringToSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + scope + '\n' + sha256hex(canonicalRequest);
  const kDate = hmac('TC3' + secretKey, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    timestamp: String(ts),
  };
}

function call(sql) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ EnvId: envId, Sql: sql });
    const s = sign(payload);
    const req = https.request({
      host: HOST, path: '/', method: 'POST',
      headers: {
        'Authorization': s.authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'Host': HOST,
        'X-TC-Action': ACTION,
        'X-TC-Timestamp': s.timestamp,
        'X-TC-Version': VERSION,
        'X-TC-Region': REGION,
        'X-TC-Token': token,
      },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.Response && j.Response.Error) return reject(new Error(JSON.stringify(j.Response.Error)));
          resolve(j.Response);
        } catch (e) { reject(new Error('bad response: ' + body.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sqlLiteral(v, col) {
  if (v === null || v === undefined) return 'NULL';
  const t = col.data_type;
  if (t === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (t === 'integer' || t === 'bigint' || t === 'numeric' || t === 'double precision' || t === 'real' || t === 'smallint')
    return String(v);
  if (t === 'jsonb' || t === 'json') {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return "'" + s.replace(/'/g, "''") + "'::" + t;
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function count(t) {
  const r = await call('SELECT count(*) AS n FROM "' + t + '"');
  return Number(JSON.parse(r.Rows[0])[0]);
}

async function main() {
  const reset = process.argv.includes('--reset');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const report = {};
  if (reset) {
    // 依赖逆序清空
    for (const t of [...ORDER].reverse()) {
      if (t === '_prisma_migrations') continue;
      const file = path.join(out, 'data', t + '.json');
      if (!fs.existsSync(file)) continue;
      await call('TRUNCATE TABLE "' + t + '" CASCADE');
      console.log('truncated ' + t);
    }
  }
  for (const t of ORDER) {
    const expected = manifest.tables[t] ? manifest.tables[t].rows : 0;
    const file = path.join(out, 'data', t + '.json');
    if (!fs.existsSync(file)) { console.log('skip ' + t); continue; }
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cols = colsByTable[t] || [];
    const colNames = cols.map(c => '"' + c.column_name + '"').join(',');
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = batch.map(row =>
        '(' + cols.map(c => sqlLiteral(row[c.column_name], c)).join(',') + ')'
      ).join(',');
      await call('INSERT INTO "' + t + '" (' + colNames + ') VALUES ' + values);
      inserted += batch.length;
      process.stdout.write('\r' + t + ': ' + inserted + '/' + rows.length);
    }
    const got = await count(t);
    report[t] = { expected, got, ok: got === expected };
    console.log('\n' + t + ': expected=' + expected + ' got=' + got + (got === expected ? ' OK' : ' MISMATCH'));
  }
  const bad = Object.entries(report).filter(([, v]) => !v.ok);
  console.log('RESULT ' + (bad.length === 0 ? 'ALL_OK' : 'FAILED ' + JSON.stringify(bad)));
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
