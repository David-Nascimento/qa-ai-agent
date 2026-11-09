// Testa a leitura dos cenários no Jira (API v3 com paginação por nextPageToken).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fakeJira(seen) {
  const page = (keys, next) => ({
    issues: keys.map(([k, s, c]) => ({
      key: k,
      fields: { summary: s, status: { name: 'Pronto' }, components: [{ name: c }] },
    })),
    ...(next ? { nextPageToken: next } : { isLast: true }),
  });
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u);
    if (req.headers.authorization !== 'Basic ' + Buffer.from('qa@x.com:tok').toString('base64')) {
      res.writeHead(401);
      return res.end();
    }
    if (u.pathname !== '/rest/api/3/search/jql') {
      res.writeHead(404);
      return res.end();
    }
    const body = u.searchParams.get('nextPageToken')
      ? page([['QA-103', 'CT-003 Pagamento com cartão inválido', 'Pagamento']])
      : page(
          [
            ['QA-101', 'CT-001 Fluxo de compra completo', 'Checkout'],
            ['QA-102', 'CT-002 Aplicar cupom', 'Checkout'],
          ],
          'p2'
        );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

test('lê os cenários do Jira com paginação e mapeia o componente', async () => {
  const seen = [];
  const jira = fakeJira(seen);
  await new Promise(r => jira.listen(0, r));
  const port = 3800 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      JIRA_URL: `http://127.0.0.1:${jira.address().port}`,
      JIRA_EMAIL: 'qa@x.com',
      JIRA_TOKEN: 'tok',
      JIRA_PROJECT: 'QA',
      JIRA_API_VERSION: '3',
      JIRA_SYNC_MS: '0',
      JENKINS_URL: '',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
    },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 400));
    const jql = 'project = QA AND issuetype = Test';
    const res = await fetch(`http://127.0.0.1:${port}/api/jira/scenarios?jql=${encodeURIComponent(jql)}`);
    const d = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(
      d.scenarios.map(s => [s.key, s.pipeline]),
      [
        ['QA-101', 'Checkout'],
        ['QA-102', 'Checkout'],
        ['QA-103', 'Pagamento'],
      ]
    );
    assert.equal(seen[0].searchParams.get('jql'), jql);
    assert.ok(d.scenarios[0].url.endsWith('/browse/QA-101'));
  } finally {
    proc.kill();
    jira.close();
  }
});
