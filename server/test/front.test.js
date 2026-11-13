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

test(
  'integrações: validação por campo e token só de escrita (visível só ao digitar, nunca depois de salvo)',
  { skip: !chromium && 'playwright não instalado' },
  async t => {
    let browser;
    try {
      browser = await chromium.launch();
    } catch {
      return t.skip('navegador do playwright indisponível');
    }
    const TOKEN = 'tok-' + 'front-secreto-98765432';
    const jenkins = http.createServer((req, res) => {
      const ok = req.headers.authorization === 'Basic ' + Buffer.from(`qa:${TOKEN}`).toString('base64');
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise(r => jenkins.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'e2e-int-'));
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
    const porta = 4500 + Math.floor(Math.random() * 200);
    const srv = spawn(process.execPath, [join(RAIZ, 'server/server.js')], {
      env: {
        ...process.env,
        PORT: String(porta),
        API_KEY: 'k-e2e-integ',
        SECRETS_KEY: 'chave-mestra-e2e-1234567890',
        INTEGRATIONS_FILE: join(dir, 'i.json'),
        HISTORY_FILE: 'off',
        JIRA_SYNC_MS: '0',
        JENKINS_URL: '',
        JENKINS_TOKEN: '',
        GITHUB_TOKEN: '',
        JIRA_URL: '',
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
      },
      stdio: 'ignore',
    });
    try {
      await new Promise(r => setTimeout(r, 1200));
      const p = await browser.newPage({ viewport: { width: 1360, height: 900 } });
      const erros = [];
      p.on('pageerror', e => erros.push(e.message));
      p.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text());
      });
      let puts = 0;
      p.on('request', r => {
        if (r.method() === 'PUT') puts++;
      });
      await p.goto(
        `http://127.0.0.1:${estatico.address().port}/index.html?api=http://127.0.0.1:${porta}&key=k-e2e-integ#integracoes`
      );
      await p.waitForTimeout(1200);
      await p.click('[data-int="jenkins"]');
      await p.waitForSelector('#igToken');

      // token: mascarado, "Mostrar" só habilita ao digitar, volta a mascarar ao sair do campo
      assert.equal(await p.getAttribute('#igToken', 'type'), 'password');
      assert.equal(await p.isDisabled('#igShow'), true);
      await p.fill('#igToken', TOKEN);
      assert.equal(await p.isDisabled('#igShow'), false);
      await p.click('#igShow');
      assert.equal(await p.getAttribute('#igToken', 'type'), 'text');
      await p.focus('#igUrl');
      assert.equal(await p.getAttribute('#igToken', 'type'), 'password', 'sair do campo mascara de novo');

      // validações: nada é enviado enquanto houver erro
      await p.fill('#igUrl', 'http://jenkins.exemplo.com');
      await p.fill('#igUser', 'qa user!');
      await p.fill('#igJobs', '../x');
      await p.click('#mForm .btn-pri');
      for (const c of ['Url', 'User', 'Jobs'])
        assert.ok((await p.textContent(`#ig${c}Err`)).length > 5, `erro em ${c}`);
      assert.equal(await p.getAttribute('#igUrl', 'aria-invalid'), 'true');
      assert.equal(puts, 0);

      // credencial errada não fecha nem salva; a certa testa, salva e fecha
      await p.fill('#igUrl', `http://127.0.0.1:${jenkins.address().port}`);
      await p.fill('#igUser', 'qa');
      await p.fill('#igJobs', 'Loja/e2e');
      await p.fill('#igToken', 'token-errado-1234');
      await p.click('#mForm .btn-pri');
      await p.waitForFunction(() => document.querySelector('#igTokenErr')?.textContent.length > 5);
      assert.equal(await p.isHidden('#modal'), false, 'credencial recusada: não fecha');
      await p.fill('#igToken', TOKEN);
      await p.click('#mForm .btn-pri');
      await p.waitForSelector('#modal', { state: 'hidden' });
      await p.waitForFunction(() => /Token salvo cifrado/.test(document.querySelector('#ints').textContent));

      // depois de salvo: o token não existe mais na tela, no armazenamento nem em campo algum
      await p.click('[data-intmenu="jenkins"]');
      await p.click('#menu button:has-text("Editar")');
      await p.waitForSelector('#igReplace');
      assert.equal(await p.locator('#igShow').count(), 0, 'sem botão Mostrar para token salvo');
      assert.equal(await p.locator('input[type=password], input[name=token]').count(), 0, 'sem campo com o token');
      const vazou = await p.evaluate(
        t =>
          [
            document.documentElement.outerHTML,
            JSON.stringify(localStorage),
            JSON.stringify(sessionStorage),
            [...document.querySelectorAll('input,textarea')].map(i => i.value).join('|'),
          ].some(x => x.includes(t)),
        TOKEN
      );
      assert.equal(vazou, false);
      // trocar o token mostra um campo novo, vazio
      await p.click('#igReplace');
      assert.equal(await p.inputValue('#igToken'), '');
      assert.deepEqual(erros, []);
    } finally {
      await browser.close();
      srv.kill();
      estatico.close();
      jenkins.close();
    }
  }
);
