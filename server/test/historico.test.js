// Testa o histórico em arquivo: arquiva ao terminar, substitui re-run, limita o tamanho,
// grava com permissão 600 e se recupera de arquivo corrompido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'hist-'));
const file = join(dir, 'sub', 'historico.json');
process.env.HISTORY_FILE = file;
process.env.HISTORY_MAX = '10';
const { observe, flushHistory, listHistory } = await import('../historico.js');

const start = (job, build) => ({ job, build, name: 'Fluxo', timestamp: 1 });
const roda = (job, build, status = 'Sucesso') => {
  observe('build_start', start(job, build));
  observe('scenario', { job, build, name: 'CT-001', status: 'pass', duration: 1 });
  observe('scenario', { job, build, name: 'CT-001', status: 'fail', duration: 2 }); // a última leitura vale
  observe('build_end', { job, build, status, passed: 0, failed: 1, total: 1, duration: 5 });
};

test('arquiva a execução ao terminar, com o último estado de cada cenário', () => {
  observe('build_start', start('a', 1));
  assert.equal(listHistory().length, 0, 'em andamento não entra');
  roda('a', 2);
  const [r] = listHistory();
  assert.equal(r.start.build, 2);
  assert.deepEqual(
    r.scenarios.map(s => s.status),
    ['fail']
  );
  assert.equal(r.end.status, 'Sucesso');
});

test('re-run com o mesmo número substitui a execução antiga e o arquivo é gravado com permissão 600', () => {
  roda('a', 2, 'Falha');
  assert.equal(listHistory().length, 1);
  assert.equal(listHistory()[0].end.status, 'Falha');
  flushHistory();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('respeita HISTORY_MAX e eventos sem job são ignorados', () => {
  for (let i = 10; i < 30; i++) roda('b', i);
  observe('build_end', {});
  assert.equal(listHistory().length, 10);
  assert.equal(listHistory(3).length, 3);
  assert.equal(listHistory().at(-1).start.build, 29, 'ficam as mais novas');
});

test('arquivo corrompido vira cópia .corrompido e o servidor começa vazio', () => {
  const ruim = join(dir, 'ruim.json');
  writeFileSync(ruim, '{isto não é json');
  const r = spawnSync(
    process.execPath,
    ['-e', "import('./historico.js').then(m => { m.loadHistory(); console.log(m.listHistory().length); })"],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HISTORY_FILE: ruim },
      encoding: 'utf8',
    }
  );
  assert.match(r.stdout, /\n?0\n?$/);
  assert.ok(readdirSync(dir).some(f => f.startsWith('ruim.json.corrompido-')));
});
