// Testa a proteção contra limite de requisições: o Jenkins responde 429 e 503 no meio do build
// e o servidor precisa esperar, tentar de novo e concluir como Sucesso (e não como Falha).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOG =
  '  ✓  1 [chromium] › a.spec.ts:1:1 › CT-001 Fluxo (1.0s)\n  ✓  2 [chromium] › a.spec.ts:2:1 › CT-002 Cupom (1.0s)\n';

function fakeJenkins(stats) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = d => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    const base = '/job/Loja/job/Checkout';
    if (u.pathname === `${base}/api/json`)
      return json({ builds: [{ number: 9, building: !stats.done, timestamp: Date.now(), estimatedDuration: 1000 }] });
    if (u.pathname === `${base}/9/logText/progressiveText`) {
      stats.log++;
      if (stats.log === 1) {
        res.writeHead(429, { 'Retry-After': '0' }); // pede calma
        return res.end();
      }
      if (stats.log === 2) {
        res.writeHead(503); // queda passageira
        return res.end();
      }
      stats.done = true;
      res.writeHead(200, { 'X-Text-Size': String(LOG.length) });
      return res.end(LOG);
    }
    if (u.pathname === `${base}/9/wfapi/describe`) {
      stats.stages++;
      return json({ stages: [] });
    }
    if (u.pathname === `${base}/9/api/json`) return json({ result: 'SUCCESS', duration: 2000 });
    if (u.pathname === `${base}/9/testReport/api/json`) return json({ passCount: 2, failCount: 0, skipCount: 0 });
    res.writeHead(404);
    res.end();
  });
}

test('429 e 503 do Jenkins não viram Falha: o servidor espera, repete e conclui o build', async () => {
  const stats = { log: 0, stages: 0, done: false };
  const jenkins = fakeJenkins(stats);
  await new Promise(r => jenkins.listen(0, r));
  const port = 3700 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      JENKINS_URL: `http://127.0.0.1:${jenkins.address().port}`,
      JENKINS_USER: 'qa',
      JENKINS_TOKEN: 'tok',
      JENKINS_JOBS: 'Loja/Checkout',
      POLL_MS: '100',
      DISCOVER_MS: '60000',
      HTTP_RETRIES: '1', // 1 repetição por chamada: o 503 estoura a repetição e cai no tratamento do build
      HTTP_BACKOFF_MS: '50',
      JIRA_SYNC_MS: '0',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
    },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 300));
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tempo esgotado')), 8000);
      http
        .get(`http://127.0.0.1:${port}/events`, res => {
          let buf = '';
          res.on('data', c => {
            buf += c;
            const blocks = buf.split('\n\n');
            buf = blocks.pop();
            for (const b of blocks) {
              const type = b.match(/^event: (.+)$/m)?.[1];
              if (type) events.push({ type, data: JSON.parse(b.match(/^data: (.+)$/m)[1]) });
            }
            if (events.some(e => e.type === 'build_end')) {
              clearTimeout(timer);
              res.destroy();
              resolve();
            }
          });
        })
        .on('error', reject);
    });
    const end = events.find(e => e.type === 'build_end').data;
    assert.equal(end.status, 'Sucesso');
    assert.equal(end.passed, 2);
    assert.ok(stats.log >= 3, `esperava 3+ leituras do log, houve ${stats.log}`);
    assert.ok(stats.stages >= 1);
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.ok(h.slow.jenkins >= 1, 'o fator de lentidão aparece no /api/health');
  } finally {
    proc.kill();
    jenkins.close();
  }
});
