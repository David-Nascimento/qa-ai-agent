// Teste de ponta a ponta da interface num navegador real (Playwright).
// Playwright não é dependência do projeto: sem ele (ou sem navegador) os testes são pulados.
//   - nenhuma tela dá erro de JavaScript nem viola a CSP
//   - a chave sai da URL e o SSE conecta por tíquete
//   - o histórico gravado pelo servidor reaparece na tela, sem dados de exemplo
//   - Azure DevOps não aparece como "Conectado" e o modal de integração não pede token
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  /* sem playwright */
}
const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const reg = (b, st) => ({
  start: {
    job: 'acme/loja/e2e.yml',
    build: b,
    name: 'E2E Checkout',
    source: 'GitHub Actions',
    timestamp: Date.now() - (10 - b) * 36e5,
  },
  scenarios: [
    { job: 'acme/loja/e2e.yml', build: b, name: 'CT-010 Carrinho', status: 'pass', duration: 2 },
    {
      job: 'acme/loja/e2e.yml',
      build: b,
      name: 'CT-012 Pagamento',
      status: st === 'Falha' ? 'fail' : 'pass',
      duration: 3,
    },
  ],
  end: {
    job: 'acme/loja/e2e.yml',
    build: b,
    status: st,
    duration: 5000,
    passed: st === 'Falha' ? 1 : 2,
    failed: st === 'Falha' ? 1 : 0,
    total: 2,
  },
});

test(
  'interface conectada: sem erros, chave fora da URL, tíquete, histórico real e integrações',
  { skip: !chromium && 'playwright não instalado' },
  async t => {
    let browser;
    try {
      browser = await chromium.launch();
    } catch {
      return t.skip('navegador do playwright indisponível');
    }
    const arquivo = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'h.json');
    writeFileSync(arquivo, JSON.stringify([reg(1, 'Sucesso'), reg(2, 'Falha'), reg(3, 'Sucesso')]));
    const estatico = http.createServer((req, res) => {
      const f = join(RAIZ, normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, ''));
      try {
        res.writeHead(200, { 'Content-Type': TIPOS[extname(f)] || 'application/octet-stream' });
        res.end(readFileSync(f));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(r => estatico.listen(0, r));
    const porta = 4200 + Math.floor(Math.random() * 300);
    const srv = spawn(process.execPath, [join(RAIZ, 'server/server.js')], {
      env: {
        ...process.env,
        PORT: String(porta),
        API_KEY: 'k-e2e',
        HISTORY_FILE: arquivo,
        JIRA_SYNC_MS: '0',
        JENKINS_URL: '',
        GITHUB_TOKEN: '',
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
      },
      stdio: 'ignore',
    });
    try {
      await new Promise(r => setTimeout(r, 1200));
      const p = await browser.newPage({ viewport: { width: 1360, height: 860 } });
      const erros = [];
      const pedidos = [];
      p.on('pageerror', e => erros.push(e.message));
      p.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text());
      });
      p.on('request', r => pedidos.push(r.method() + ' ' + new URL(r.url()).pathname));
      await p.goto(`http://127.0.0.1:${estatico.address().port}/index.html?api=http://127.0.0.1:${porta}&key=k-e2e`);
      await p.waitForTimeout(1500);

      assert.ok(!p.url().includes('key='), 'a chave saiu da URL');
      assert.ok(pedidos.includes('POST /api/ticket') && pedidos.includes('GET /events'), 'SSE abriu por tíquete');
      for (const r of [
        'dashboard',
        'pipelines',
        'execucoes',
        'aovivo',
        'cenarios',
        'analises',
        'integracoes',
        'config',
      ]) {
        await p.evaluate(h => (location.hash = h), r);
        await p.waitForTimeout(200);
      }
      for (const aba of ['tempo', 'estab', 'geral']) {
        await p.evaluate(() => (location.hash = 'analises'));
        await p.evaluate(x => document.querySelector(`#aTabs [data-t="${x}"]`)?.click(), aba);
        await p.waitForTimeout(150);
      }
      const runs = await p.evaluate(() => RUNS.map(r => [r.p, r.s, r.ok + '/' + r.t]));
      assert.deepEqual(runs, [
        ['E2E Checkout', 'Sucesso', '2/2'],
        ['E2E Checkout', 'Falha', '1/2'],
        ['E2E Checkout', 'Sucesso', '2/2'],
      ]);
      assert.equal(await p.evaluate(() => INTS.find(i => i.k === 'azure').on), false);
      await p.evaluate(() => configInt(INTS.find(i => i.k === 'azure')));
      assert.equal(await p.evaluate(() => !!document.querySelector('#modalBox input[type=password]')), false);
      assert.deepEqual(erros, [], 'sem erros de JavaScript nem violações de CSP');
    } finally {
      await browser.close();
      srv.kill();
      estatico.close();
    }
  }
);
