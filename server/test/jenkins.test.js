// Testa o servidor contra um Jenkins falso: descoberta do build, leitura
// progressiva do log, tempo de resposta, estágios e resultado final.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOG =
  [
    'Running 3 tests using 1 worker',
    '[resp] CT-001 Fluxo de compra completo 412ms',
    '  \x1b[32m✓\x1b[39m  1 [chromium] › checkout.spec.ts:12:5 › CT-001 Fluxo de compra completo (1.2s)',
    '  ✓  2 [chromium] › checkout.spec.ts:20:5 › CT-002 Aplicar cupom de desconto (842ms)',
    '  ✘  3 [chromium] › checkout.spec.ts:30:5 › CT-004 Timeout na API de pagamento (30.0s)',
    '  1 failed',
  ].join('\n') + '\n';

function fakeJenkins() {
  let reads = 0;
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = d => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('qa:tok').toString('base64')) {
      res.writeHead(401);
      return res.end();
    }
    if (u.pathname === '/job/E-commerce/job/Checkout/api/json')
      return json({
        builds: [{ number: 77, building: reads < 2, timestamp: Date.now() - 5000, estimatedDuration: 60000 }],
      });
    if (u.pathname === '/job/E-commerce/job/Checkout/77/logText/progressiveText') {
      const start = +u.searchParams.get('start');
      reads++;
      const cut = 140; // corta no meio de uma linha para testar o buffer
      const part = reads === 1 ? LOG.slice(0, cut) : LOG.slice(start);
      res.writeHead(200, {
        'X-Text-Size': String(reads === 1 ? cut : LOG.length),
        ...(reads === 1 ? { 'X-More-Data': 'true' } : {}),
      });
      return res.end(part);
    }
    if (u.pathname === '/job/E-commerce/job/Checkout/77/wfapi/describe')
      return json({
        stages: [{ name: 'Testes', status: reads < 2 ? 'IN_PROGRESS' : 'SUCCESS', durationMillis: 1000 }],
      });
    if (u.pathname === '/job/E-commerce/job/Checkout/77/api/json') return json({ result: 'UNSTABLE', duration: 32000 });
    if (u.pathname === '/job/E-commerce/job/Checkout/77/testReport/api/json')
      return json({ passCount: 2, failCount: 1, skipCount: 0 });
    res.writeHead(404);
    res.end();
  });
}

test('lê o build do Jenkins e emite os eventos em tempo real', async () => {
  const jenkins = fakeJenkins();
  await new Promise(r => jenkins.listen(0, r));
  const port = 3900 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      JENKINS_URL: `http://127.0.0.1:${jenkins.address().port}`,
      JENKINS_USER: 'qa',
      JENKINS_TOKEN: 'tok',
      JENKINS_JOBS: 'E-commerce/Checkout',
      POLL_MS: '200',
      DISCOVER_MS: '60000',
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
            for (const block of buf.split('\n\n').slice(0, -1)) {
              const type = block.match(/^event: (.+)$/m)?.[1];
              const data = block.match(/^data: (.+)$/m)?.[1];
              if (type) events.push({ type, data: JSON.parse(data) });
            }
            buf = buf.split('\n\n').pop();
            if (events.some(e => e.type === 'build_end')) {
              clearTimeout(timer);
              res.destroy();
              resolve();
            }
          });
        })
        .on('error', reject);
    });
    const scen = events.filter(e => e.type === 'scenario').map(e => e.data);
    assert.deepEqual(
      scen.map(s => [s.name, s.status]),
      [
        ['CT-001 Fluxo de compra completo', 'pass'],
        ['CT-002 Aplicar cupom de desconto', 'pass'],
        ['CT-004 Timeout na API de pagamento', 'fail'],
      ]
    );
    assert.equal(scen[0].resp, 412);
    assert.equal(scen[1].duration, 0.84);
    assert.ok(events.some(e => e.type === 'stage' && e.data.status === 'SUCCESS'));
    const end = events.find(e => e.type === 'build_end').data;
    assert.equal(end.status, 'Falha');
    assert.equal(end.passed, 2);
    assert.equal(end.total, 3);
  } finally {
    proc.kill();
    jenkins.close();
  }
});
