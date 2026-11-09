// Testa a sincronização do Jira com os ciclos do Zephyr Scale (Server/Data Center):
// leitura inicial, ligação pela chave do caso (PROJ-T123), 429 com Retry-After e busca incremental.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fakeJira(seen) {
  let searchHits = 0;
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u);
    const json = d => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    if (req.headers.authorization !== 'Bearer pat-123') {
      res.writeHead(401);
      return res.end();
    }
    // Issues dos cenários (Jira Data Center: API v2). A chave do caso vem no título.
    if (u.pathname === '/rest/api/2/search') {
      const only = u.searchParams.get('jql').includes('updated >= -');
      const rows = [
        ['QA-101', 'CT-001 Fluxo de compra [QA-T1]', 'Checkout'],
        ['QA-102', 'CT-002 Cupom [QA-T2]', 'Checkout'],
        ['QA-103', 'CT-003 Cartão inválido [QA-T3]', 'Pagamento'],
      ].slice(0, only ? 1 : 3);
      return json({
        total: rows.length,
        issues: rows.map(([key, summary, c]) => ({
          key,
          fields: {
            summary,
            status: { name: 'Pronto' },
            components: [{ name: c }],
            updated: '2026-11-01T10:00:00.000+0000',
          },
        })),
      });
    }
    // API ATM do Zephyr Scale Server/DC
    if (u.pathname === '/rest/atm/1.0/testrun/search') {
      searchHits++;
      if (searchHits === 1) {
        res.writeHead(429, { 'Retry-After': '0' }); // 1ª chamada recusada
        return res.end();
      }
      return json([
        {
          key: 'QA-R1',
          name: 'Regressão Sprint 42',
          status: 'In Progress',
          folder: '/Regressão',
          updatedOn: new Date().toISOString(),
        },
        { key: 'QA-R0', name: 'Smoke antigo', status: 'Done', folder: '/Smoke', updatedOn: '2026-01-01T10:00:00Z' },
      ]);
    }
    if (u.pathname === '/rest/atm/1.0/testrun/QA-R1')
      return json({
        key: 'QA-R1',
        items: [
          { testCaseKey: 'QA-T1', status: 'Pass' },
          { testCaseKey: 'QA-T2', status: 'Fail' },
          { testCaseKey: 'QA-T9', status: 'Not Executed' }, // caso sem cenário no Jira
        ],
      });
    if (u.pathname === '/rest/atm/1.0/testrun/QA-R0')
      return json({ key: 'QA-R0', items: [{ testCaseKey: 'QA-T3', status: 'Pass' }] });
    res.writeHead(404);
    res.end();
  });
}

test('sincroniza cenários e ciclos do Zephyr, liga pela chave do caso e faz busca incremental', async () => {
  const seen = [];
  const jira = fakeJira(seen);
  await new Promise(r => jira.listen(0, r));
  const port = 3600 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      JIRA_URL: `http://127.0.0.1:${jira.address().port}`,
      JIRA_TOKEN: 'pat-123',
      JIRA_AUTH: 'bearer',
      JIRA_PROJECT: 'QA',
      JIRA_API_VERSION: '2',
      ZEPHYR: 'true',
      JIRA_SYNC_MS: '700',
      JIRA_GAP_MS: '0',
      HTTP_BACKOFF_MS: '20',
      JENKINS_URL: '',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
    },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 1900)); // 1ª rodada completa + pelo menos 1 incremental
    const d = await (await fetch(`http://127.0.0.1:${port}/api/jira/state`)).json();

    assert.equal(d.error, null);
    assert.deepEqual(
      d.scenarios.map(s => [s.key, s.caseKey]),
      [
        ['QA-101', 'QA-T1'],
        ['QA-102', 'QA-T2'],
        ['QA-103', 'QA-T3'],
      ]
    );
    // 429 na 1ª chamada dos ciclos: o servidor esperou e repetiu, então os ciclos chegaram
    const r1 = d.cycles.find(c => c.key === 'QA-R1');
    assert.deepEqual(r1.totals, { total: 3, pass: 1, fail: 1, blocked: 0, run: 0, pend: 1, unlinked: 1 });
    assert.equal(d.cycles[0].key, 'QA-R1', 'ciclos do mais recente para o mais antigo');
    // cada cenário mostra em quais ciclos está e com qual resultado
    assert.deepEqual(d.scenarios.find(s => s.key === 'QA-102').cycles, [
      { key: 'QA-R1', name: 'Regressão Sprint 42', status: 'fail' },
    ]);
    assert.equal(d.scenarios.find(s => s.key === 'QA-103').cycles[0].key, 'QA-R0');

    // rodadas seguintes são incrementais (JQL relativa) e só relêem os ciclos ativos
    const jqls = seen.filter(u => u.pathname === '/rest/api/2/search').map(u => u.searchParams.get('jql'));
    assert.ok(jqls.length >= 2, 'houve ao menos uma rodada incremental');
    assert.ok(!jqls[0].includes('updated >='), 'a primeira é completa');
    assert.ok(
      jqls.slice(1).every(j => /^\(.+\) AND updated >= -\d+m ORDER BY key$/.test(j)),
      jqls.join(' | ')
    );
    assert.equal(seen.filter(u => u.pathname.endsWith('/testrun/QA-R0')).length, 1, 'ciclo encerrado é lido uma vez');
    assert.ok(seen.filter(u => u.pathname.endsWith('/testrun/QA-R1')).length >= 2, 'ciclo ativo é relido');

    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(h.zephyr, true);
    assert.ok(h.jiraSync.at);
  } finally {
    proc.kill();
    jira.close();
  }
});
