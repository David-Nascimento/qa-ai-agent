// Endurecimento do servidor: falha fechado sem chave, chave forte, CORS restrito, consultas e parâmetros validados,
// IP do cliente atrás de proxy e log de auditoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JIRA_PROJECT = 'QA';
process.env.TRUST_PROXY = 'true';
process.env.HISTORY_FILE = 'off';
process.env.AUDIT_FILE = 'off';
delete process.env.API_KEY;
delete process.env.API_KEY_HASH;
const { checkScenarioQuery } = await import('../jira.js');
const { checkParams, clientIp } = await import('../web.js');

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const BASE_ENV = {
  ...process.env,
  JIRA_SYNC_MS: '0',
  JENKINS_URL: '',
  GITHUB_TOKEN: '',
  HTTPS_PROXY: '',
  HTTP_PROXY: '',
  SECRETS_KEY_FILE: '',
  SECRETS_KEY: '',
  API_KEY: '',
  API_KEY_HASH: '',
  TRUST_PROXY: 'false',
  JIRA_PROJECT: '',
  AUDIT_FILE: 'off',
};
const CHAVE = 'chave-forte-de-teste-0001';

// roda o servidor só até ele falhar ou escutar; devolve código de saída e saída de texto
function partida(extra) {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...BASE_ENV, PORT: '0', ...extra },
    timeout: 1500,
    encoding: 'utf8',
  });
  return { code: r.status, text: (r.stdout || '') + (r.stderr || '') };
}
async function subir(extra) {
  const port = 5200 + Math.floor(Math.random() * 600);
  const proc = spawn(process.execPath, [SERVER], { env: { ...BASE_ENV, DEMO: 'true', PORT: String(port), ...extra } });
  const out = { text: '' };
  proc.stdout.on('data', d => (out.text += d));
  proc.stderr.on('data', d => (out.text += d));
  for (let i = 0; i < 60 && !/Rede:/.test(out.text); i++) await new Promise(r => setTimeout(r, 100));
  return { proc, out, base: `http://127.0.0.1:${port}` };
}

test('falha fechado: sem chave não expõe na rede; chave fraca é recusada', () => {
  const aberto = partida({ HOST: '0.0.0.0', DEMO: 'true' });
  assert.notEqual(aberto.code, 0);
  assert.match(aberto.text, /aberto na rede sem chave/);
  for (const fraca of ['curta', 'aaaaaaaaaaaaaaaaaaaa', 'abababababababab']) {
    const r = partida({ API_KEY: fraca, DEMO: 'true' });
    assert.notEqual(r.code, 0, fraca);
    assert.match(r.text, /API_KEY fraca/);
  }
  assert.match(partida({ CORS_ORIGIN: 'qualquer coisa', DEMO: 'true' }).text, /CORS_ORIGIN inválido/);
});

test('sem chave só escuta em 127.0.0.1; exposto na rede o CORS não libera origem alguma', async () => {
  const local = await subir({});
  try {
    assert.match(local.out.text, /só esta máquina \(127\.0\.0\.1\)/);
    const r = await fetch(local.base + '/api/health', { method: 'OPTIONS', headers: { Origin: 'https://x.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), '*', 'uso local continua simples');
  } finally {
    local.proc.kill();
  }
  const rede = await subir({ API_KEY: CHAVE });
  try {
    assert.match(rede.out.text, /escutando na rede/);
    const r = await fetch(rede.base + '/api/health', { method: 'OPTIONS', headers: { Origin: 'https://x.com' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'sem CORS_ORIGIN nenhuma origem externa');
    const j = await fetch(rede.base + '/api/health');
    assert.equal(j.headers.get('access-control-allow-origin'), null);
  } finally {
    rede.proc.kill();
  }
  const certa = await subir({ API_KEY: CHAVE, CORS_ORIGIN: 'https://qa.exemplo.com' });
  try {
    const r = await fetch(certa.base + '/api/health', { method: 'OPTIONS' });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://qa.exemplo.com');
  } finally {
    certa.proc.kill();
  }
});

test('consulta de cenários é presa ao projeto e o campo é validado', () => {
  assert.deepEqual(checkScenarioQuery(null, null), {});
  assert.equal(
    checkScenarioQuery('project = SECRETO ORDER BY key', 'customfield_10010').jql,
    '(project = SECRETO) AND project = "QA" ORDER BY key',
    'mesmo pedindo outro projeto, a consulta continua restrita ao QA'
  );
  assert.equal(checkScenarioQuery('project = QA', 'components').field, 'components');
  for (const f of ['x; drop', 'a b', '../x']) assert.throws(() => checkScenarioQuery(null, f), /field/);
  assert.throws(() => checkScenarioQuery('a'.repeat(2001)), /jql/);
  assert.throws(() => checkScenarioQuery('project = QA\u0000'), /jql/);
});

test('parâmetros de build: só objeto simples, curto e com nomes comuns', () => {
  assert.deepEqual(checkParams(undefined), {});
  assert.deepEqual(checkParams({ ref: 'main', ENV: 'qa', N: 3 }), { ref: 'main', ENV: 'qa', N: 3 });
  for (const ruim of [
    'texto',
    ['a'],
    { 'a b': 1 },
    { a: { b: 1 } },
    { a: 'x'.repeat(1001) },
    Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, 1])),
  ])
    assert.throws(
      () => checkParams(ruim),
      e => e.client === 400,
      JSON.stringify(ruim).slice(0, 40)
    );
});

test('IP do cliente atrás de proxy confiável é o último do X-Forwarded-For (o primeiro é forjável)', () => {
  const req = h => ({ headers: h, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req({})), '10.0.0.1');
});

test('auditoria: registra ações e falhas sem gravar chave nem token, com permissão 600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aud-'));
  const arq = join(dir, 'sub', 'auditoria.log');
  const s = await subir({ API_KEY: CHAVE, HOST: '127.0.0.1', AUDIT_FILE: arq, AUTH_MAX_FAILS: '3' });
  try {
    for (let i = 0; i < 3; i++)
      await fetch(s.base + '/api/state', { headers: { 'x-api-key': 'errada-errada-errada-' + i } });
    const ok = { 'x-api-key': CHAVE, 'content-type': 'application/json' };
    // bloqueado pelo limitador? o IP é o mesmo: usa outro IP via proxy confiável não existe aqui, então confere o bloqueio
    const bloqueado = await fetch(s.base + '/api/build', {
      method: 'POST',
      headers: ok,
      body: JSON.stringify({ job: 'x' }),
    });
    assert.equal(bloqueado.status, 429);
  } finally {
    s.proc.kill();
  }
  assert.ok(existsSync(arq));
  assert.equal(statSync(arq).mode & 0o777, 0o600);
  const txt = readFileSync(arq, 'utf8');
  const ev = txt
    .trim()
    .split('\n')
    .map(l => JSON.parse(l).evento);
  assert.deepEqual(ev, ['chave_invalida', 'ip_bloqueado'], 'só a 1ª falha e o bloqueio: invasor não enche o arquivo');
  assert.ok(!txt.includes(CHAVE) && !txt.includes('errada-errada'));
});

test('auditoria: disparo de build e parada ficam registrados', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aud-'));
  const arq = join(dir, 'auditoria.log');
  const s = await subir({ API_KEY: CHAVE, HOST: '127.0.0.1', AUDIT_FILE: arq });
  try {
    const h = { 'x-api-key': CHAVE, 'content-type': 'application/json' };
    assert.equal(
      (await fetch(s.base + '/api/build', { method: 'POST', headers: h, body: JSON.stringify({ job: 'Loja/e2e' }) }))
        .status,
      202
    );
    assert.equal(
      (
        await fetch(s.base + '/api/stop', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ job: 'Loja/e2e', build: 7 }),
        })
      ).status,
      202
    );
  } finally {
    s.proc.kill();
  }
  const linhas = readFileSync(arq, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  assert.deepEqual(
    linhas.map(l => l.evento),
    ['build_disparado', 'build_parado']
  );
  assert.equal(linhas[1].build, '7');
  assert.equal(linhas[0].ip.includes('127.0.0.1'), true);
});
