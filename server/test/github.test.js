// Testa a integração com o GitHub Actions usando um GitHub falso:
// descobre o run, lê os jobs (estágios), tolera o limite de chamadas (403 + x-ratelimit-remaining: 0),
// usa ETag (304 não gasta limite), lê o log do job concluído e fecha o build como Sucesso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STAMP = '2026-01-01T10:00:00.0000000Z ';
const LOG =
  `${STAMP}##[group]Run npx playwright test\n` +
  `${STAMP}  ✓  1 [chromium] › a.spec.ts:1:1 › CT-001 Fluxo (1.0s)\n` +
  `${STAMP}  ✓  2 [chromium] › a.spec.ts:2:1 › CT-002 Cupom (1.0s)\n`;

function fakeGithub(stats) {
  const base = '/repos/acme/loja';
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer tok') stats.badAuth++;
    const json = (d, etag) => {
      if (etag && req.headers['if-none-match'] === etag) {
        stats.notModified++;
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        ...(etag ? { ETag: etag } : {}),
      });
      res.end(JSON.stringify(d));
    };
    const run = status => ({
      id: 777,
      run_number: 12,
      name: 'E2E',
      path: '.github/workflows/e2e.yml',
      status,
      conclusion: status === 'completed' ? 'success' : null,
      head_branch: 'main',
      html_url: 'https://github.test/acme/loja/actions/runs/777',
      run_started_at: new Date(Date.now() - 5000).toISOString(),
      created_at: new Date(Date.now() - 6000).toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (u.pathname === `${base}/actions/workflows/e2e.yml/runs`) {
      stats.discover++;
      return json({ workflow_runs: [run(stats.done ? 'completed' : 'in_progress')] }, `"d-${stats.done}"`);
    }
    if (u.pathname === `${base}/actions/runs/777`) {
      stats.runs++;
      const s = stats.done ? 'completed' : 'in_progress';
      return json(run(s), `"r-${s}"`);
    }
    if (u.pathname === `${base}/actions/runs/777/jobs`) {
      stats.jobs++;
      if (stats.jobs === 1) {
        // limite de chamadas: o servidor deve esperar e repetir, sem marcar o run como falha
        stats.limited++;
        res.writeHead(403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
          'Retry-After': '0',
        });
        return res.end('{"message":"API rate limit exceeded"}');
      }
      stats.phase++;
      const job = done => ({
        id: 1,
        name: 'Testes E2E',
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? 'success' : null,
        started_at: new Date(Date.now() - 4000).toISOString(),
        completed_at: done ? new Date().toISOString() : null,
      });
      const done = stats.phase >= 3;
      return json({ total_count: 1, jobs: [job(done)] }, `"j-${done}"`);
    }
    if (u.pathname === `${base}/actions/jobs/1/logs`) {
      stats.logs++;
      stats.done = true;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(LOG);
    }
    res.writeHead(404);
    res.end('{}');
  });
}

test('GitHub Actions: acompanha o run, tolera o limite, usa ETag e lê os cenários do log', async () => {
  const stats = {
    discover: 0,
    runs: 0,
    jobs: 0,
    phase: 0,
    logs: 0,
    limited: 0,
    notModified: 0,
    badAuth: 0,
    done: false,
  };
  const github = fakeGithub(stats);
  await new Promise(r => github.listen(0, r));
  const port = 3800 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`,
      GITHUB_TOKEN: 'tok',
      GITHUB_WORKFLOWS: 'acme/loja/e2e.yml',
      GITHUB_POLL_MS: '100',
      GITHUB_DISCOVER_MS: '60000',
      HTTP_RETRIES: '1',
      HTTP_BACKOFF_MS: '50',
      JENKINS_URL: '',
      JENKINS_JOBS: '',
      JIRA_URL: '',
      JIRA_SYNC_MS: '0',
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
            const blocks = buf.split('\n\n');
            buf = blocks.pop();
            for (const b of blocks) {
              const type = b.match(/^event: (.+)$/m)?.[1];
              if (type) events.push({ type, data: JSON.parse(b.match(/^data: (.+)$/m)[1]) });
            }
            if (events.some(e => e.type === 'build_end')) {
              clearTimeout(timer);
              res.destroy();
              resolve();
            }
          });
        })
        .on('error', reject);
    });

    const start = events.find(e => e.type === 'build_start').data;
    assert.equal(start.job, 'acme/loja/e2e.yml');
    assert.equal(start.build, 12);
    assert.equal(start.folder, 'acme/loja');
    assert.equal(start.source, 'GitHub Actions');
    assert.equal(start.branch, 'main');

    const stages = events.filter(e => e.type === 'stage').map(e => `${e.data.stage}:${e.data.status}`);
    assert.deepEqual(stages, ['Testes E2E:IN_PROGRESS', 'Testes E2E:SUCCESS']);

    const scen = events.filter(e => e.type === 'scenario').map(e => `${e.data.name}:${e.data.status}`);
    assert.deepEqual(scen, ['CT-001 Fluxo:pass', 'CT-002 Cupom:pass']); // carimbo de hora removido do log

    const end = events.find(e => e.type === 'build_end').data;
    assert.equal(end.status, 'Sucesso');
    assert.equal(end.passed, 2);
    assert.equal(end.total, 2);

    assert.equal(stats.badAuth, 0, 'todas as chamadas levam o token');
    assert.ok(stats.limited >= 1, 'o 403 de limite foi enviado');
    assert.ok(stats.notModified >= 1, 'respostas 304 (ETag) foram usadas');
    assert.equal(stats.logs, 1, 'o log do job é baixado uma única vez');

    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(h.github, true);
    assert.deepEqual(h.workflows, ['acme/loja/e2e.yml']);
    assert.equal(h.githubRate.remaining, 4999);
  } finally {
    proc.kill();
    github.close();
  }
});

test('GitHub Actions: limite esgotado com reset distante não derruba o run nem martela a API', async () => {
  const stats = { runs: 0 };
  const github = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/runs') && u.pathname.includes('/workflows/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 9,
              run_number: 3,
              name: 'CI',
              path: '.github/workflows/ci.yml',
              status: 'in_progress',
              html_url: 'x',
            },
          ],
        })
      );
    }
    stats.runs++;
    res.writeHead(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), // volta só daqui a 1 h
    });
    res.end('{"message":"API rate limit exceeded"}');
  });
  await new Promise(r => github.listen(0, r));
  const port = 3890 + Math.floor(Math.random() * 100);
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`,
      GITHUB_TOKEN: 'tok',
      GITHUB_WORKFLOWS: 'acme/loja/ci.yml',
      GITHUB_POLL_MS: '50',
      GITHUB_DISCOVER_MS: '60000',
      HTTP_RETRIES: '3',
      HTTP_BACKOFF_MS: '50',
      JENKINS_URL: '',
      JENKINS_JOBS: '',
      JIRA_URL: '',
      JIRA_SYNC_MS: '0',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
    },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 1500));
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(h.githubRate.remaining, 0);
    assert.equal(h.active, 1, 'o run continua em acompanhamento (não virou Falha)');
    assert.ok(h.slow.github > 1, 'o intervalo de leitura aumentou');
    assert.equal(stats.runs, 1, 'sem insistir enquanto o limite não volta');
  } finally {
    proc.kill();
    github.close();
  }
});
