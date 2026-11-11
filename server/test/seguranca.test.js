// Testa as proteções das rotas e da configuração:
// - só jobs configurados podem ser disparados/parados (nada de "..", nada de job desconhecido)
// - corpo inválido responde 400, não 502
// - a chave da API protege as rotas e esconde nomes de jobs do /api/health
// - variável numérica inválida (POLL_MS=abc) não faz o servidor disparar sem parar
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('rotas de comando só aceitam jobs configurados e exigem a chave', async () => {
  const hits = [];
  const jenkins = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url.includes('/api/json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"builds":[]}');
    }
    res.writeHead(201);
    res.end();
  });
  await new Promise(r => jenkins.listen(0, r));
  const port = 3700 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: 'segredo',
      JENKINS_URL: `http://127.0.0.1:${jenkins.address().port}`,
      JENKINS_USER: 'qa',
      JENKINS_TOKEN: 'tok',
      JENKINS_JOBS: 'Loja/Checkout',
      POLL_MS: 'abc', // inválido: volta ao padrão em vez de virar NaN
      DISCOVER_MS: '',
      JIRA_SYNC_MS: '0',
      GITHUB_TOKEN: '',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, key = 'segredo', raw = false) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: raw ? body : JSON.stringify(body),
    });
  try {
    await new Promise(r => setTimeout(r, 500));
    const antes = hits.length;

    assert.equal((await post('/api/build', { job: 'Loja/Checkout' }, '')).status, 401, 'sem chave');
    assert.equal((await post('/api/build', { job: 'Loja/Checkout' }, 'errada')).status, 401, 'chave errada');
    assert.equal((await post('/api/build', { job: 'Outro/Job' })).status, 403, 'job fora da lista');
    assert.equal((await post('/api/build', { job: '../../script' })).status, 403, 'caminho com ..');
    assert.equal((await post('/api/stop', { job: 'Outro/Job', build: 1 })).status, 403);
    assert.equal(
      (await post('/api/stop', { job: 'Loja/Checkout', build: '1/../../x' })).status,
      400,
      'build não numérico'
    );
    assert.equal((await post('/api/build', '{quebrado', 'segredo', true)).status, 400, 'JSON inválido');
    const jobsChamados = hits.slice(antes).filter(h => h.startsWith('POST'));
    assert.deepEqual(jobsChamados, [], 'nada foi enviado ao Jenkins');

    // job configurado: aceita o caminho completo e também só o nome, por ser único
    assert.equal((await post('/api/build', { job: 'Loja/Checkout' })).status, 202);
    assert.equal((await post('/api/build', { job: 'Checkout' })).status, 202);
    const builds = hits.filter(h => h === 'POST /job/Loja/job/Checkout/build');
    assert.equal(builds.length, 2);

    // /api/health: sem chave não mostra nomes de jobs; com chave mostra
    const pub = await (await fetch(`${base}/api/health`)).json();
    assert.equal(pub.jobs, undefined);
    assert.equal(pub.jenkins, true);
    const priv = await (await fetch(`${base}/api/health`, { headers: { 'x-api-key': 'segredo' } })).json();
    assert.deepEqual(priv.jobs, ['Loja/Checkout']);

    // POLL_MS=abc e DISCOVER_MS vazio: o servidor não martela o Jenkins (descoberta 1x na partida)
    const descobertas = hits.filter(h => h.includes('/api/json')).length;
    assert.ok(descobertas <= 2, `esperava poucas descobertas, houve ${descobertas}`);
  } finally {
    proc.kill();
    jenkins.close();
  }
});
