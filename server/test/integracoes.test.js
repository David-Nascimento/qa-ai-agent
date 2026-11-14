// Testa o cofre de integrações: validação, teste de conexão antes de salvar, token só de escrita,
// arquivo cifrado, recarga após reiniciar, integração do .env somente leitura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const KEY = { 'x-api-key': 'chave-de-teste-integracoes', 'content-type': 'application/json' };
const TOKEN = 'tok-' + 'segredo-do-jenkins-123456';
const MESTRA = 'chave-mestra-de-teste-1234567890';
const dir = mkdtempSync(join(tmpdir(), 'integ-'));
const arquivo = join(dir, 'sub', 'integracoes.json');

// Jenkins falso: só aceita o usuário/token certos e conhece o job "Loja/e2e"
const vistos = [];
const jenkins = http.createServer((req, res) => {
  vistos.push(req.headers.authorization);
  const ok = req.headers.authorization === 'Basic ' + Buffer.from(`qa:${TOKEN}`).toString('base64');
  if (!ok) return res.writeHead(401).end();
  if (req.url.startsWith('/job/Loja/job/e2e/') || req.url.startsWith('/api/json'))
    return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  res.writeHead(404).end();
});
await new Promise(r => jenkins.listen(0, '127.0.0.1', r));
const JURL = `http://127.0.0.1:${jenkins.address().port}`;

async function subir(extra = {}) {
  const port = 4600 + Math.floor(Math.random() * 300);
  const out = { text: '' };
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: 'chave-de-teste-integracoes',
      SECRETS_KEY: MESTRA,
      INTEGRATIONS_FILE: arquivo,
      HISTORY_FILE: 'off',
      JIRA_SYNC_MS: '0',
      JENKINS_URL: '',
      JENKINS_TOKEN: '',
      JENKINS_JOBS: '',
      GITHUB_TOKEN: '',
      JIRA_URL: '',
      JIRA_TOKEN: '',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      ...extra,
    },
  });
  proc.stdout.on('data', d => (out.text += d));
  proc.stderr.on('data', d => (out.text += d));
  for (let i = 0; i < 60 && !/servidor em|Nenhuma fonte|Jenkins:/.test(out.text); i++)
    await new Promise(r => setTimeout(r, 100));
  const base = `http://127.0.0.1:${port}`;
  const api = (m, p, body) =>
    fetch(base + p, { method: m, headers: KEY, body: body === undefined ? undefined : JSON.stringify(body) }).then(
      async r => ({ status: r.status, json: await r.json().catch(() => ({})) })
    );
  return { proc, out, api, base };
}

test('validação campo a campo: nada inválido chega ao Jenkins nem ao arquivo', async () => {
  const s = await subir();
  try {
    const r = await s.api('PUT', '/api/integrations/jenkins', {
      url: 'http://jenkins.exemplo.com',
      user: 'qa user!',
      token: 'curto',
      jobs: '../x\nLoja//e2e',
    });
    assert.equal(r.status, 400);
    for (const c of ['url', 'user', 'token', 'jobs']) assert.ok(r.json.errors[c], `erro em ${c}`);
    const g = await s.api('PUT', '/api/integrations/github', {
      workflows: 'sem-barra',
      token: 'não-é-token-do-github',
    });
    assert.ok(g.json.errors.workflows && g.json.errors.token);
    const j = await s.api('PUT', '/api/integrations/jira', {
      url: 'https://user:pw@x.atlassian.net',
      email: 'nao-e-email',
      project: 'qa',
      version: '9',
      token: 'abcdefgh1234',
    });
    for (const c of ['url', 'email', 'project', 'version']) assert.ok(j.json.errors[c], `jira ${c}`);
    assert.equal(vistos.length, 0, 'o Jenkins não foi consultado');
  } finally {
    s.proc.kill();
  }
});

test('credencial errada não grava; certa grava cifrado, mantém o token só no servidor e sobrevive a reinício', async () => {
  const s = await subir();
  try {
    const ruim = await s.api('PUT', '/api/integrations/jenkins', {
      url: JURL,
      user: 'qa',
      token: 'token-errado-123',
      jobs: 'Loja/e2e',
    });
    assert.equal(ruim.status, 422);
    assert.ok(ruim.json.errors.token);
    assert.equal((await s.api('GET', '/api/integrations')).json.items.jenkins.configured, false);

    const naoExiste = await s.api('PUT', '/api/integrations/jenkins', {
      url: JURL,
      user: 'qa',
      token: TOKEN,
      jobs: 'Loja/outro',
    });
    assert.equal(naoExiste.status, 422);
    assert.ok(naoExiste.json.errors.jobs);

    const ok = await s.api('PUT', '/api/integrations/jenkins', {
      url: JURL,
      user: 'qa',
      token: TOKEN,
      jobs: 'Loja/e2e',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.source, 'ui');
    assert.equal(ok.json.tokenSet, true);
    // o token nunca volta em nenhuma resposta
    const todos = JSON.stringify([
      ok.json,
      (await s.api('GET', '/api/integrations')).json,
      (await s.api('GET', '/api/health')).json,
    ]);
    assert.ok(!todos.includes(TOKEN));
    // nem aparece no arquivo ou no log; o arquivo é 600 e cifrado
    const bruto = readFileSync(arquivo, 'utf8');
    assert.ok(!bruto.includes(TOKEN) && bruto.includes('enc:v1:'));
    assert.equal(statSync(arquivo).mode & 0o777, 0o600);
    assert.ok(!s.out.text.includes(TOKEN));

    // reaproveitar o token salvo: ok com o mesmo endereço; exige token novo se o endereço mudar
    const mesmo = await s.api('PUT', '/api/integrations/jenkins', { url: JURL, user: 'qa', jobs: 'Loja/e2e' });
    assert.equal(mesmo.status, 200);
    const desvio = await s.api('PUT', '/api/integrations/jenkins', {
      url: JURL.replace('127.0.0.1', 'localhost'),
      user: 'qa',
      jobs: 'Loja/e2e',
    });
    assert.equal(desvio.status, 400);
    assert.match(desvio.json.errors.token, /endereço mudou/);

    // testar sem salvar, com os dados atuais
    const t = await s.api('POST', '/api/integrations/jenkins/test', {});
    assert.equal(t.status, 200);
  } finally {
    s.proc.kill();
  }
  // reinício: lê o arquivo cifrado com a chave-mestra
  const s2 = await subir();
  try {
    const g = (await s2.api('GET', '/api/integrations')).json.items.jenkins;
    assert.equal(g.configured, true);
    assert.equal(g.source, 'ui');
    assert.deepEqual(g.jobs, ['Loja/e2e']);
    assert.ok(!JSON.stringify(g).includes(TOKEN));
    // remover apaga do arquivo e da memória
    const d = await s2.api('DELETE', '/api/integrations/jenkins');
    assert.equal(d.json.configured, false);
    assert.ok(!JSON.parse(readFileSync(arquivo, 'utf8')).items.jenkins);
  } finally {
    s2.proc.kill();
  }
});

test('só edita com chave da API e chave-mestra; integração do .env é somente leitura', async () => {
  const semMestra = await subir({ SECRETS_KEY: '' });
  try {
    const g = (await semMestra.api('GET', '/api/integrations')).json;
    assert.equal(g.edit.ok, false);
    assert.match(g.edit.reason, /SECRETS_KEY_FILE/);
    assert.equal(
      (
        await semMestra.api('PUT', '/api/integrations/jenkins', {
          url: JURL,
          user: 'qa',
          token: TOKEN,
          jobs: 'Loja/e2e',
        })
      ).status,
      409
    );
  } finally {
    semMestra.proc.kill();
  }
  const doEnv = await subir({ JENKINS_URL: JURL, JENKINS_USER: 'qa', JENKINS_TOKEN: TOKEN, JENKINS_JOBS: 'Loja/e2e' });
  try {
    const g = (await doEnv.api('GET', '/api/integrations')).json.items.jenkins;
    assert.equal(g.source, 'env');
    assert.equal(
      (await doEnv.api('PUT', '/api/integrations/jenkins', { url: JURL, user: 'qa', token: TOKEN, jobs: 'Loja/e2e' }))
        .status,
      409
    );
    assert.equal((await doEnv.api('DELETE', '/api/integrations/jenkins')).status, 409);
  } finally {
    doEnv.proc.kill();
  }
  const semChave = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '4999',
      API_KEY: '',
      API_KEY_HASH: '',
      SECRETS_KEY: MESTRA,
      INTEGRATIONS_FILE: arquivo,
      HISTORY_FILE: 'off',
      HTTPS_PROXY: '',
    },
  });
  try {
    await new Promise(r => setTimeout(r, 1200));
    const g = await (await fetch('http://127.0.0.1:4999/api/integrations')).json();
    assert.match(g.edit.reason, /API_KEY/);
  } finally {
    semChave.kill();
  }
});

test.after(() => jenkins.close());
