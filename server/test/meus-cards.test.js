// "Meus cards": issues do projeto atribuídas a quem gerou o token (assignee = currentUser()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const BASE = {
  ...process.env,
  JIRA_SYNC_MS: '0',
  JENKINS_URL: '',
  GITHUB_TOKEN: '',
  HTTPS_PROXY: '',
  HTTP_PROXY: '',
  HISTORY_FILE: 'off',
  AUDIT_FILE: 'off',
  API_KEY: '',
  API_KEY_HASH: '',
};
const subir = async env => {
  const port = 6100 + Math.floor(Math.random() * 600);
  const proc = spawn(process.execPath, [SERVER], { env: { ...BASE, PORT: String(port), ...env }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  return { proc, base: `http://127.0.0.1:${port}` };
};

test('lê os cards do dono do token, só do projeto, com cache e sem repetir a consulta', async () => {
  const seen = [];
  const jira = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.pathname === '/rest/api/3/myself') return res.end(JSON.stringify({ displayName: 'Ana QA' }));
    const it = (key, summary, cat, status) => ({
      key,
      fields: {
        summary,
        status: { name: status, statusCategory: { key: cat } },
        priority: { name: 'High' },
        issuetype: { name: 'Bug' },
        updated: '2026-11-12T10:00:00.000-0300',
        duedate: '2026-11-20',
      },
    });
    if (u.searchParams.get('nextPageToken'))
      return res.end(JSON.stringify({ issues: [it('QA-3', 'Terceiro', 'done', 'Concluído')] }));
    res.end(
      JSON.stringify({
        issues: [it('QA-1', 'Primeiro', 'indeterminate', 'Em andamento'), it('QA-2', 'Segundo', 'new', 'A fazer')],
        nextPageToken: 'p2',
      })
    );
  });
  await new Promise(r => jira.listen(0, '127.0.0.1', r));
  const s = await subir({
    JIRA_URL: `http://127.0.0.1:${jira.address().port}`,
    JIRA_EMAIL: 'a@x.com',
    JIRA_TOKEN: 'tok-de-teste',
    JIRA_PROJECT: 'QA',
    JIRA_MINE_DONE_DAYS: '3',
  });
  try {
    const r = await fetch(s.base + '/api/jira/mine');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.me, 'Ana QA');
    assert.deepEqual(
      d.cards.map(c => [c.key, c.category, c.status]),
      [
        ['QA-1', 'indeterminate', 'Em andamento'],
        ['QA-2', 'new', 'A fazer'],
        ['QA-3', 'done', 'Concluído'],
      ]
    );
    assert.equal(d.cards[0].priority, 'High');
    assert.equal(d.cards[0].due, '2026-11-20');
    assert.ok(d.cards[0].url.endsWith('/browse/QA-1'));
    const jql = seen.find(u => u.searchParams.has('jql')).searchParams.get('jql');
    assert.equal(
      jql,
      'project = "QA" AND assignee = currentUser() AND (statusCategory != Done OR resolved >= -3d) ORDER BY updated DESC'
    );
    const chamadas = seen.length;
    // segunda leitura vem do cache; "refresh" colado na anterior também (no máx. 1 consulta a cada 5 s)
    assert.equal((await (await fetch(s.base + '/api/jira/mine')).json()).cached, true);
    assert.equal((await (await fetch(s.base + '/api/jira/mine?refresh=1')).json()).cached, true);
    assert.equal(seen.length, chamadas, 'o Jira não foi consultado de novo');
  } finally {
    s.proc.kill();
    jira.close();
  }
});

test('modo demonstração mostra exemplos; sem Jira configurado responde 400', async () => {
  const demo = await subir({ DEMO: 'true' });
  try {
    const d = await (await fetch(demo.base + '/api/jira/mine')).json();
    assert.equal(d.demo, true);
    assert.ok(
      d.cards.length >= 5 && d.cards.some(c => c.category === 'done') && d.cards.some(c => c.category === 'new')
    );
  } finally {
    demo.proc.kill();
  }
  const nada = await subir({ JIRA_URL: '', JIRA_TOKEN: '' });
  try {
    const r = await fetch(nada.base + '/api/jira/mine');
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Jira não configurado/);
  } finally {
    nada.proc.kill();
  }
});
