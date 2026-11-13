// Testa a proteção de credenciais:
// - criptografia AES-256-GCM (ida e volta, adulteração, chave errada) e hash scrypt
// - tokens cifrados no ambiente são decifrados só na memória e chegam corretos ao Jenkins
// - API_KEY_HASH, tíquete SSE de uso único, bloqueio de tentativas, cabeçalhos de segurança
// - upstream http:// com credencial é recusado; logs não mostram segredos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { abrir, conferirChave, gerarChave, hashChave, selar } from '../cripto.js';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const MESTRA = 'chave-mestra-de-teste-1234567890';
const BASE_ENV = {
  ...process.env,
  JIRA_SYNC_MS: '0',
  GITHUB_TOKEN: '',
  HTTPS_PROXY: '',
  HTTP_PROXY: '',
  SECRETS_KEY_FILE: '',
  SECRETS_KEY: '',
  API_KEY: '',
  API_KEY_HASH: '',
};

// sobe o servidor e espera ele escutar; devolve processo, saída acumulada e a porta
async function subir(extra) {
  const port = 3800 + Math.floor(Math.random() * 150);
  const proc = spawn(process.execPath, [SERVER], { env: { ...BASE_ENV, PORT: String(port), ...extra } });
  const out = { text: '' };
  proc.stdout.on('data', d => (out.text += d));
  proc.stderr.on('data', d => (out.text += d));
  const fim = new Promise(r => proc.on('exit', code => r(code)));
  for (let i = 0; i < 60 && !/servidor em/.test(out.text); i++) {
    if (proc.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, out, fim, base: `http://127.0.0.1:${port}` };
}

test('cifra e decifra, detecta adulteração e chave errada, nunca repete o texto cifrado', () => {
  const a = selar('ghp_segredo', MESTRA);
  const b = selar('ghp_segredo', MESTRA);
  assert.match(a, /^enc:v1:/);
  assert.notEqual(a, b, 'salt e IV novos a cada vez');
  assert.ok(!a.includes('ghp_segredo'));
  assert.equal(abrir(a, MESTRA), 'ghp_segredo');
  assert.throws(() => abrir(a, MESTRA + 'x'), /decifrar/);
  const partes = a.split(':');
  const ct = Buffer.from(partes[5], 'base64');
  ct[0] ^= 1; // 1 bit alterado
  partes[5] = ct.toString('base64');
  assert.throws(() => abrir(partes.join(':'), MESTRA), /decifrar/, 'GCM detecta adulteração');
  assert.throws(() => selar('x', 'curta'), /curta/);
  assert.ok(Buffer.from(gerarChave(), 'base64').length === 32);
  const h = hashChave('minha-chave');
  assert.ok(conferirChave('minha-chave', h));
  assert.ok(!conferirChave('outra', h));
  assert.ok(!conferirChave('minha-chave', 'lixo'));
});

test('tokens cifrados são decifrados na memória e chegam corretos ao Jenkins, sem aparecer no log', async () => {
  const auth = [];
  const jenkins = http.createServer((req, res) => {
    auth.push(req.headers.authorization);
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => jenkins.listen(0, r));
  const FALSO = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123'; // montado em tempo de execução: não é um token de verdade
  const job = `Loja/${FALSO}`;
  const s = await subir({
    SECRETS_KEY: MESTRA,
    JENKINS_URL: `http://127.0.0.1:${jenkins.address().port}`,
    JENKINS_USER: 'qa',
    JENKINS_TOKEN: selar('tok-super-secreto', MESTRA),
    JENKINS_JOBS: job,
  });
  try {
    for (let i = 0; i < 30 && !auth.length; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(auth[0], 'Basic ' + Buffer.from('qa:tok-super-secreto').toString('base64'));
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!s.out.text.includes('tok-super-secreto'), 'token não aparece no log');
    assert.ok(!s.out.text.includes(FALSO), 'padrão de token é mascarado no log');
  } finally {
    s.proc.kill();
    jenkins.close();
  }
});

test('valor cifrado com chave errada impede a partida e diz qual variável falhou', async () => {
  const s = await subir({
    SECRETS_KEY: MESTRA + '!',
    JENKINS_URL: 'http://127.0.0.1:9',
    JENKINS_TOKEN: selar('x-token', MESTRA),
    JENKINS_JOBS: 'a',
  });
  assert.equal(await s.fim, 1);
  assert.match(s.out.text, /JENKINS_TOKEN/);
  assert.ok(!s.out.text.includes('x-token'));
});

test('upstream http:// com credencial é recusado (exceto loopback ou ALLOW_INSECURE_UPSTREAM)', async () => {
  const s = await subir({ JENKINS_URL: 'http://jenkins.exemplo.com', JENKINS_TOKEN: 'abc123456', JENKINS_JOBS: 'a' });
  assert.equal(await s.fim, 1);
  assert.match(s.out.text, /JENKINS_URL.*https/);
  const ok = await subir({
    JENKINS_URL: 'http://jenkins.exemplo.com',
    JENKINS_TOKEN: 'abc123456',
    JENKINS_JOBS: 'a',
    ALLOW_INSECURE_UPSTREAM: 'true',
  });
  try {
    assert.equal(ok.proc.exitCode, null, 'com a exceção explícita o servidor sobe');
  } finally {
    ok.proc.kill();
  }
});

test('API_KEY_HASH, tíquete SSE de uso único, cabeçalhos de segurança e bloqueio de tentativas', async () => {
  const chave = 'chave-da-api-de-teste';
  const s = await subir({ API_KEY_HASH: hashChave(chave), DEMO: 'true', AUTH_MAX_FAILS: '4' });
  const h = { 'x-api-key': chave };
  try {
    // chave certa (cabeçalho) passa; sem chave e chave na URL (desativada por padrão) não passam
    const ok = await fetch(s.base + '/api/state', { headers: h });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
    assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await fetch(s.base + `/api/state?key=${chave}`)).status, 401, '?key= desligado por padrão');

    // tíquete: exige a chave, vale uma conexão, não serve para as demais rotas
    assert.equal((await fetch(s.base + '/api/ticket', { method: 'POST' })).status, 401);
    const t = await (await fetch(s.base + '/api/ticket', { method: 'POST', headers: h })).json();
    assert.ok(t.ticket && t.ticket.length >= 20);
    assert.equal((await fetch(s.base + `/api/state?ticket=${t.ticket}`)).status, 401, 'tíquete só abre o /events');
    const ac = new AbortController();
    const ev = await fetch(s.base + `/events?ticket=${t.ticket}`, { signal: ac.signal });
    assert.equal(ev.status, 200);
    assert.match(ev.headers.get('content-type'), /text\/event-stream/);
    ac.abort();
    assert.equal((await fetch(s.base + `/events?ticket=${t.ticket}`)).status, 401, 'tíquete já usado');

    // bloqueio: após AUTH_MAX_FAILS falhas do mesmo IP, 429 com Retry-After (mesmo com a chave certa)
    let ultimo;
    for (let i = 0; i < 6; i++) ultimo = await fetch(s.base + '/api/state', { headers: { 'x-api-key': 'errada' + i } });
    assert.equal(ultimo.status, 429);
    assert.ok(Number(ultimo.headers.get('retry-after')) > 0);
    assert.equal((await fetch(s.base + '/api/state', { headers: h })).status, 429);
  } finally {
    s.proc.kill();
  }
});

test('API_KEY cifrada também funciona como chave da API', async () => {
  const s = await subir({ SECRETS_KEY: MESTRA, API_KEY: selar('minha-api-key', MESTRA), DEMO: 'true' });
  try {
    assert.equal((await fetch(s.base + '/api/state', { headers: { 'x-api-key': 'minha-api-key' } })).status, 200);
    assert.equal((await fetch(s.base + '/api/state', { headers: { 'x-api-key': 'enc:v1:x' } })).status, 401);
  } finally {
    s.proc.kill();
  }
});

test('varredura de segredos acha token em arquivo versionado e passa em repositório limpo', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const script = fileURLToPath(new URL('../scripts/verificar-segredos.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'ok.env'), 'JENKINS_TOKEN=enc:v1:abc\nAPI_KEY=\nGITHUB_TOKEN=seu-token-aqui\n');
  git('add', '.');
  assert.equal(spawnSync(process.execPath, [script, dir]).status, 0, 'valores cifrados e vazios passam');
  writeFileSync(join(dir, 'ruim.js'), "const t = 'ghp_" + 'a'.repeat(36) + "';\n");
  git('add', '.');
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ruim\.js:1\s+token do GitHub/);
  assert.ok(!r.stderr.includes('a'.repeat(36)), 'o relatório não repete o segredo');
});

test('transporte: dados só entram por canal criptografado (proxy HTTPS confiável, TLS nativo ou máquina local)', async () => {
  const chave = { 'x-api-key': 'chave-de-transporte-123' };
  const s = await subir({ API_KEY: 'chave-de-transporte-123', DEMO: 'true' });
  try {
    // da própria máquina, direto: ok
    assert.equal((await fetch(s.base + '/api/state', { headers: chave })).status, 200);
    // chegou por um proxy (X-Forwarded-*) que não é confiável: recusa, e não conta como tentativa de chave
    const proxy = { ...chave, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
    const r = await fetch(s.base + '/api/state', { headers: proxy });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'tls_required');
    // a chave também não pode ir por "http" ao /api/health
    assert.equal((await fetch(s.base + '/api/health', { headers: proxy })).status, 403);
    // health sem chave continua público e informa se a conexão é segura
    const h = await (await fetch(s.base + '/api/health', { headers: { 'x-forwarded-for': '203.0.113.9' } })).json();
    assert.equal(h.secure, false);
  } finally {
    s.proc.kill();
  }
  const conf = await subir({ API_KEY: 'chave-de-transporte-123', DEMO: 'true', TRUST_PROXY: 'true' });
  try {
    const base = { ...chave, 'x-forwarded-for': '203.0.113.9' };
    assert.equal(
      (await fetch(conf.base + '/api/state', { headers: { ...base, 'x-forwarded-proto': 'https' } })).status,
      200,
      'proxy confiável com https'
    );
    assert.equal(
      (await fetch(conf.base + '/api/state', { headers: { ...base, 'x-forwarded-proto': 'http' } })).status,
      403,
      'proxy confiável, mas o cliente usou http'
    );
    assert.equal(
      (await fetch(conf.base + '/api/state', { headers: base })).status,
      403,
      'proxy sem informar o protocolo'
    );
  } finally {
    conf.proc.kill();
  }
  const aberto = await subir({ API_KEY: 'chave-de-transporte-123', DEMO: 'true', ALLOW_INSECURE_TRANSPORT: 'true' });
  try {
    assert.equal(
      (await fetch(aberto.base + '/api/state', { headers: { ...chave, 'x-forwarded-for': '203.0.113.9' } })).status,
      200
    );
    assert.match(
      aberto.out.text,
      /ALLOW_INSECURE_TRANSPORT=true/,
      'o log avisa que está aceitando dados sem criptografia'
    );
  } finally {
    aberto.proc.kill();
  }
});

test('HTTPS nativo: certificado real, TLS 1.2+, HSTS e a chave nunca em claro', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'tls-'));
  const gen = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(d, 'k.pem'),
    '-out',
    join(d, 'c.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  if (gen.status !== 0) return; // sem openssl no ambiente: pula
  const s = await subir({
    API_KEY: 'chave-tls-123456789',
    DEMO: 'true',
    TLS_CERT_FILE: join(d, 'c.pem'),
    TLS_KEY_FILE: join(d, 'k.pem'),
  });
  try {
    const { default: https } = await import('node:https');
    const { readFileSync } = await import('node:fs');
    const ca = readFileSync(join(d, 'c.pem'));
    const porta = new URL(s.base).port;
    const pedir = (path, opts = {}) =>
      new Promise((ok, erro) => {
        const rq = https.request(
          { host: '127.0.0.1', port: porta, path, ca, servername: 'localhost', agent: false, ...opts },
          r => {
            const proto = r.socket.getProtocol();
            let t = '';
            r.on('data', c => (t += c));
            r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: t, proto }));
          }
        );
        rq.on('error', erro);
        rq.end();
      });
    const r = await pedir('/api/state', { headers: { 'x-api-key': 'chave-tls-123456789' } });
    assert.equal(r.status, 200);
    assert.match(r.proto, /^TLSv1\.[23]$/);
    assert.match(r.headers['strict-transport-security'], /max-age=31536000/);
    // TLS 1.1 ou menor é recusado
    await assert.rejects(pedir('/api/health', { maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }));
    // pelo canal sem criptografia nem existe resposta HTTP legível
    assert.match(s.out.text, /HTTPS nativo/);
  } finally {
    s.proc.kill();
  }
});
