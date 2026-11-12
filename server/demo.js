import { log, sleep } from './config.js';
import { emit } from './eventos.js';
import { jcache } from './jira.js';

export const DEMO_SCENARIOS = [
  ['QA-101', 'CT-001 Fluxo de compra completo', 'Checkout'],
  ['QA-102', 'CT-002 Aplicar cupom de desconto', 'Checkout'],
  ['QA-103', 'CT-003 Pagamento com cartão inválido', 'Pagamento'],
  ['QA-104', 'CT-004 Timeout na API de pagamento', 'Pagamento'],
  ['QA-105', 'CT-005 Validação de carrinho vazio', 'Checkout'],
  ['QA-130', 'CT-030 Login no app', 'App do Cliente'],
].map(([key, name, pipeline], i) => ({ key, name, status: 'Pronto', pipeline, caseKey: `QA-T${i + 1}`, url: '' }));

// Dados de exemplo para o modo demonstração (sem Jira)
export function seedDemoJira() {
  for (const s of DEMO_SCENARIOS) jcache.scenarios.set(s.key, s);
  const cycle = (key, name, status, st) => {
    const items = DEMO_SCENARIOS.map((s, i) => ({ case: s.caseKey, status: st[i] || 'pend' }));
    jcache.cycles.set(key, {
      meta: { key, name, status, folder: '/Regressão', updated: new Date().toISOString(), start: '', end: '' },
      items,
      sig: '',
    });
  };
  cycle('QA-R1', 'Regressão Sprint 42', 'In Progress', ['pass', 'pass', 'fail', 'fail', 'pend', 'pass']);
  cycle('QA-R2', 'Smoke da release 3.8', 'Done', ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  jcache.syncedAt = Date.now();
}

/* ------------------------------------------------------------------ */
/* Modo demonstração (sem Jenkins)                                     */
/* ------------------------------------------------------------------ */
export function startDemo() {
  const jobs = {
    Checkout: [
      'CT-001 Fluxo de compra completo',
      'CT-002 Aplicar cupom de desconto',
      'CT-003 Pagamento com cartão inválido',
      'CT-004 Timeout na API de pagamento',
      'CT-005 Validação de carrinho vazio',
      'CT-006 Calcular frete por CEP',
    ],
    Pagamento: [
      'CT-007 Pagar com Pix',
      'CT-008 Estorno parcial',
      'CT-020 Autorizar cartão',
      'CT-021 Capturar pagamento',
      'CT-022 Webhook do gateway',
    ],
    'App do Cliente': [
      'CT-030 Login no app',
      'CT-031 Listar pedidos',
      'CT-032 Rastrear entrega',
      'CT-033 Notificação de status',
    ],
  };
  let n = 5000;
  const running = new Set();
  async function run(job) {
    running.add(job);
    const build = ++n,
      start = Date.now(),
      names = jobs[job];
    emit('build_start', {
      job,
      build,
      timestamp: start,
      estimatedDuration: names.length * 4000,
      scenarios: names,
      total: names.length,
    });
    let passed = 0;
    for (const name of names) {
      emit('scenario', {
        job,
        build,
        name,
        status: 'run',
        duration: 0,
        elapsed: Math.round((Date.now() - start) / 1000),
      });
      const dur = 1500 + Math.random() * 3000;
      await sleep(dur);
      const fail = /Timeout|Estorno/.test(name) ? Math.random() < 0.5 : Math.random() < 0.05;
      if (!fail) passed++;
      emit('scenario', {
        job,
        build,
        name,
        status: fail ? 'fail' : 'pass',
        duration: +(dur / 1000).toFixed(2),
        resp: fail && /Timeout/.test(name) ? 30000 : Math.round(120 + Math.random() * 700),
        elapsed: Math.round((Date.now() - start) / 1000),
      });
    }
    emit('build_end', {
      job,
      build,
      status: passed === names.length ? 'Sucesso' : 'Falha',
      duration: Date.now() - start,
      passed,
      failed: names.length - passed,
      total: names.length,
    });
    running.delete(job);
  }
  setInterval(() => {
    const free = Object.keys(jobs).filter(j => !running.has(j));
    if (running.size < 2 && free.length) run(free[Math.floor(Math.random() * free.length)]);
  }, 3000);
  log('Modo demonstração ativo: gerando execuções fictícias.');
}
