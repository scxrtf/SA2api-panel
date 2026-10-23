// Explicit opt-in: local HTTP mock + real gateway/database; removes only this run's rows.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { loadEnvConfig } = require('@next/env');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

async function main() {
  assert.equal(process.env.RUN_PROVIDER_LIVE_SMOKE, '1', 'Set RUN_PROVIDER_LIVE_SMOKE=1 to opt in');
  loadEnvConfig(process.cwd());
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const name = 'smoke_' + randomUUID().replaceAll('-', '');
  const absent = name + '_missing';
  let mode = 'json';
  let hits = 0;
  const wire = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3,"prompt_cache_hit_tokens":5}}\n\n' +
    'data: [DONE]\n\n';
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer test-only');
      assert.equal(body.model, 'test-model');
      hits++;
      if (mode === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }));
      } else {
        await new Promise(resolve => setTimeout(resolve, 80));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mode === 'error' ? 'data: {"error":{"message":"test failure"}}\n\ndata: [DONE]\n\n' : wire);
      }
    } catch { res.writeHead(500); res.end('mock assertion failed'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const key = process.env.WB2A_API_KEY || (await db.apiKey.findFirst({ select: { key: true } }))?.key || '';
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
    const base = 'http://127.0.0.1:3000';
    const schema = await db.$queryRaw`SELECT conname::text FROM pg_constraint WHERE conname IN ('UsageEvent_uid_fkey', 'RequestLog_uid_fkey')`;
    assert.equal(schema.length, 0, 'audit foreign keys removed');
    await db.provider.create({ data: { name, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', models: 'test-model' } });
    async function chat(model = name + ':test-model', stream = false) {
      return fetch(base + '/api/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'local smoke test' }] }),
        signal: AbortSignal.timeout(60_000) });
    }
    let response = await chat();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usage.total_tokens, 23);
    mode = 'sse';
    response = await chat(undefined, true);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), wire);
    mode = 'error';
    await (await chat(undefined, true)).text();
    assert.equal((await chat(absent + ':test-model')).status, 400);
    assert.equal((await chat(name + ':disabled')).status, 400);
    assert.equal(hits, 3, 'invalid routes never call upstream');
    const rows = await db.requestLog.findMany({ where: { provider: name }, orderBy: { at: 'asc' } });
    assert.equal(rows.length, 4);
    assert.ok(rows.every(r => r.uid === '' && r.machineId === '' && r.realm === 'provider:' + name));
    const streamed = rows.find(r => r.stream && !r.errKind);
    assert.ok(streamed.ttfbMs >= 70);
    assert.equal(streamed.totalTokens, 23);
    assert.equal(streamed.cacheHitTok, 5);
    assert.equal(streamed.cacheMissTok, 15);
    assert.equal(rows.filter(r => r.errKind === 'provider_error').length, 1);
    const usage = await db.usageEvent.findMany({ where: { provider: name } });
    assert.equal(usage.length, 3);
    assert.equal(usage.filter(r => !r.ok).length, 1);
    const logs = await fetch(base + '/api/panel/request_logs?outcome=error&model=' + encodeURIComponent(name),
      { headers, signal: AbortSignal.timeout(60_000) });
    assert.equal(logs.status, 200);
    assert.ok((await logs.json()).entries.some(r => r.status === 200 && r.errKind === 'provider_error'));
    console.log('PASS real gateway HTTP + PostgreSQL: JSON, SSE bytes/TTFB/cache, error filtering, no fallback, audit inserts');
  } finally {
    // Exact unique identities only: never touch unrelated providers or historical audit rows.
    await db.$transaction([
      db.requestLog.deleteMany({ where: { provider: { in: [name, absent] } } }),
      db.usageEvent.deleteMany({ where: { provider: name } }),
      db.provider.deleteMany({ where: { name } }),
    ]);
    await db.$disconnect();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    console.log('Temporary smoke-test rows cleaned up');
  }
}
main().catch(error => { console.error(error.name + ': ' + (error.code || 'smoke assertion failed'), error.stack?.split('\n').filter(line => line.includes('provider-live-smoke')).join('\n')); process.exitCode = 1; });

