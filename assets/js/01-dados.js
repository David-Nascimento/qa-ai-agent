// QA AI Agent · Dados de exemplo: pipelines (componentes), execuções, cenários e suítes
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- Dados de exemplo ---------- */
let PIPES = store.get('pipes2', null) || [
  { name: 'Checkout', group: 'E-commerce', ico: 'box', rate: 91.2, dur: 542, scen: 15 },
  { name: 'Pagamento', group: 'E-commerce', ico: 'box', rate: 96.8, dur: 425, scen: 20 },
  { name: 'Cadastro', group: 'Cliente', ico: 'user', rate: 97.4, dur: 392, scen: 18 },
  { name: 'Busca', group: 'Catálogo', ico: 'search', rate: 98.1, dur: 251, scen: 10 },
  { name: 'Autenticação', group: 'Plataforma', ico: 'lock', rate: 99.0, dur: 188, scen: 12 },
  { name: 'Carrinho', group: 'E-commerce', ico: 'box', rate: 95.4, dur: 318, scen: 14, tech: 'API' },
  { name: 'Checkout Web', group: 'E-commerce', ico: 'box', rate: 94.1, dur: 610, scen: 16, tech: 'Web' },
  { name: 'Perfil do Cliente', group: 'Cliente', ico: 'user', rate: 98.6, dur: 214, scen: 9, tech: 'API' },
  { name: 'Endereços', group: 'Cliente', ico: 'user', rate: 97.9, dur: 176, scen: 8, tech: 'API' },
  { name: 'App do Cliente', group: 'Cliente', ico: 'user', rate: 94.8, dur: 655, scen: 17, tech: 'Mobile' },
  { name: 'Portal do Cliente', group: 'Cliente', ico: 'user', rate: 96.2, dur: 498, scen: 13, tech: 'Web' },
  { name: 'Vitrine', group: 'Catálogo', ico: 'search', rate: 97.0, dur: 402, scen: 11, tech: 'Web' },
  { name: 'Notificações Push', group: 'Plataforma', ico: 'lock', rate: 93.5, dur: 287, scen: 7, tech: 'Mobile' },
];
const TECHS = ['API', 'Mobile', 'Web'];
PIPES.forEach(p => {
  if (!p.tech) p.tech = { Checkout: 'Mobile' }[p.name] || 'API';
});
const techCls = t => (t === 'Mobile' ? 'mob' : t === 'Web' ? 'web' : 'api');
const TECH_IC = {
  API: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  Mobile: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/>',
  Web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
};
const joinPt = a => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' e ' + a.at(-1));
const techOf = n => (PIPES.find(p => p.name === n) || { tech: 'API' }).tech;
const techBadge = (t, n) =>
  `<span class="tech ${techCls(t)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">${TECH_IC[t] || TECH_IC.API}</svg>${n !== undefined ? n + ' ' : ''}${t}</span>`;
const icoOf = n =>
  ({ box: ICO_BOX, user: ICO_USER, search: ICO_SEARCH, lock: ICO_LOCK })[(PIPES.find(p => p.name === n) || {}).ico] ||
  ICO_BOX;
const groups = () => [...new Set(PIPES.map(p => p.group))];

// Execuções: as 5 primeiras são as do esboço, o restante é histórico gerado
const BASE = new Date(2026, 0, 26, 10, 24);
const fmtDate = d =>
  `${d.getDate()} ${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
let RUNS = [
  { id: 10432, p: 'Checkout', s: 'Falha', ok: 12, t: 15, d: 558, at: new Date(2026, 0, 26, 10, 24) },
  { id: 10431, p: 'Pagamento', s: 'Sucesso', ok: 20, t: 20, d: 425, at: new Date(2026, 0, 26, 10, 17) },
  { id: 10430, p: 'Cadastro', s: 'Sucesso', ok: 18, t: 18, d: 392, at: new Date(2026, 0, 26, 9, 58) },
  { id: 10429, p: 'Busca', s: 'Sucesso', ok: 10, t: 10, d: 251, at: new Date(2026, 0, 26, 9, 43) },
  { id: 10428, p: 'Checkout', s: 'Falha', ok: 11, t: 15, d: 542, at: new Date(2026, 0, 25, 18, 20) },
];
(function gen() {
  let seed = 7,
    rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let at = new Date(2026, 0, 25, 17, 40);
  const stop = new Date(BASE.getTime() - 184 * 864e5);
  for (let id = 10427; at > stop; id--) {
    const p = PIPES[Math.floor(rnd() * PIPES.length)],
      age = (BASE - at) / 864e5,
      h = at.getHours(),
      wd = at.getDay() % 6 !== 0;
    const bias = (p.name === 'Checkout' ? 4 : 0) + (age / 180) * 4 + (wd && h >= 10 && h <= 12 ? 5 : 0);
    const fail = rnd() * 100 > p.rate - bias;
    const t = p.scen;
    const ok = fail ? t - 1 - Math.floor(rnd() * 3) : t;
    RUNS.push({
      id,
      p: p.name,
      s: fail ? 'Falha' : 'Sucesso',
      ok,
      t,
      d: Math.round(p.dur * (0.9 + rnd() * 0.25)),
      at: new Date(at),
    });
    at = new Date(at - (6 + rnd() * 30) * 60000);
    if (at.getHours() < 7) {
      at.setDate(at.getDate() - 1);
      at.setHours(21, Math.floor(rnd() * 50), 0, 0);
    }
  }
})();
// Número que a pessoa vê (#87). Para execuções vindas do servidor é o número do build/run, que pode se repetir
// entre jobs; por isso r.id (usado em rotas e cartões) é sempre único e o número real fica em r.build.
const runNo = r => r.build ?? r.id;
const uniqueRunId = n => (RUNS.some(r => r.id === n) ? Math.max(...RUNS.map(r => r.id)) + 1 : n);
const grpOf = n => (PIPES.find(p => p.name === n) || { group: '—' }).group;

let SCENS =
  store.get('scens', null) ||
  [
    ['CT-001', 'Fluxo de compra completo', 'Checkout', 'Ativo'],
    ['CT-002', 'Aplicar cupom de desconto', 'Checkout', 'Ativo'],
    ['CT-003', 'Pagamento com cartão inválido', 'Pagamento', 'Ativo'],
    ['CT-004', 'Timeout na API de pagamento', 'Pagamento', 'Ativo'],
    ['CT-005', 'Validação de carrinho vazio', 'Checkout', 'Ativo'],
    ['CT-006', 'Calcular frete por CEP', 'Checkout', 'Ativo'],
    ['CT-007', 'Pagar com Pix', 'Pagamento', 'Ativo'],
    ['CT-008', 'Estorno parcial', 'Pagamento', 'Ativo'],
    ['CT-009', 'Cadastro com CPF válido', 'Cadastro', 'Ativo'],
    ['CT-010', 'Validar CPF duplicado', 'Cadastro', 'Ativo'],
    ['CT-011', 'Confirmar pedido', 'Checkout', 'Ativo'],
    ['CT-012', 'Busca por nome do produto', 'Busca', 'Ativo'],
    ['CT-013', 'Ordenar resultados por preço', 'Busca', 'Ativo'],
    ['CT-014', 'Login com e-mail e senha', 'Autenticação', 'Ativo'],
    ['CT-015', 'Recuperação de senha', 'Autenticação', 'Ativo'],
    ['CT-016', 'Checkout como visitante', 'Checkout', 'Inativo'],
  ].map(r => ({ id: r[0], name: r[1], p: r[2], s: r[3] }));
// Ciclos de exemplo (Zephyr Scale): resultado de cada cenário em cada ciclo.
// Com o servidor conectado, os ciclos reais vêm de /api/jira/state.
const CYCLES_DEMO = [
  {
    key: 'QA-R1',
    name: 'Regressão Sprint 42',
    status: 'In Progress',
    folder: '/Regressão',
    items: {
      'CT-001': 'pass',
      'CT-002': 'pass',
      'CT-003': 'fail',
      'CT-004': 'fail',
      'CT-005': 'pend',
      'CT-006': 'run',
      'CT-007': 'pass',
      'CT-008': 'blocked',
    },
  },
  {
    key: 'QA-R2',
    name: 'Smoke da release 3.8',
    status: 'Done',
    folder: '/Smoke',
    items: { 'CT-001': 'pass', 'CT-002': 'pass', 'CT-011': 'pass', 'CT-014': 'pass' },
  },
];
const saveData = () => {
  store.set('pipes2', PIPES);
  store.set('scens', SCENS);
};

// Suíte executada em cada pipeline (Checkout segue o esboço da execução #10432)
const SUITE = {
  Checkout: [
    ['CT-001 - Fluxo de compra completo', 72],
    ['CT-002 - Aplicar cupom de desconto', 42],
    ['CT-003 - Pagamento com cartão inválido', 68, 'f'],
    ['CT-004 - Timeout na API de pagamento', 81, 'f'],
    ['CT-005 - Validação de carrinho vazio', 28],
    ['CT-006 - Calcular frete por CEP', 35],
    ['CT-007 - Pagar com Pix', 47],
    ['CT-008 - Checkout como visitante', 39],
    ['CT-009 - Selecionar endereço salvo', 22],
    ['CT-010 - Parcelamento em 12x', 31],
    ['CT-011 - Confirmar pedido', 44, 'f'],
    ['CT-012 - Remover item do carrinho', 18],
    ['CT-013 - Atualizar quantidade', 21],
    ['CT-014 - Pedido mínimo', 16],
    ['CT-015 - E-mail de confirmação', 34],
  ],
};
function suiteFor(run) {
  let base = SUITE[run.p];
  if (!base) {
    const own = SCENS.filter(s => s.p === run.p);
    base = Array.from({ length: run.t }, (_, k) => [
      own[k] ? `${own[k].id} - ${own[k].name}` : `CT-${String(100 + k)} - Regressão ${run.p} ${k + 1}`,
      15 + ((k * 37) % 70),
    ]);
  }
  const fails = run.t - run.ok;
  let marked = 0;
  const list = base.slice(0, run.t).map(x => ({ n: x[0], d: x[1], f: false, pref: x[2] === 'f' }));
  list.forEach(x => {
    if (x.pref && marked < fails) {
      x.f = true;
      marked++;
    }
  });
  for (let k = list.length - 1; k >= 0 && marked < fails; k--)
    if (!list[k].f) {
      list[k].f = true;
      marked++;
    }
  return list;
}

const PERIODS = {
  7: {
    exec: '1.248',
    execD: '+12%',
    succ: '1.162',
    rate: '93,1',
    fail: '86',
    failR: '6,9',
    dur: '8m 24s',
    durD: '-18%',
    labels: ['20 jan', '21 jan', '22 jan', '23 jan', '24 jan', '25 jan', '26 jan'],
    vals: [89, 91.8, 92.1, 90, 93.4, 93, 95.5],
    split: [42, 24, 16, 18],
  },
  30: {
    exec: '5.106',
    execD: '+8%',
    succ: '4.722',
    rate: '92,5',
    fail: '384',
    failR: '7,5',
    dur: '8m 51s',
    durD: '-9%',
    labels: ['28 dez', '2 jan', '7 jan', '12 jan', '17 jan', '22 jan', '26 jan'],
    vals: [90.2, 89.4, 91.5, 92.8, 91.9, 93.6, 94.8],
    split: [38, 27, 17, 18],
  },
  90: {
    exec: '14.870',
    execD: '+21%',
    succ: '13.621',
    rate: '91,6',
    fail: '1.249',
    failR: '8,4',
    dur: '9m 17s',
    durD: '-14%',
    labels: ['out', 'nov', 'nov', 'dez', 'dez', 'jan', 'jan'],
    vals: [88.1, 89.6, 90.3, 89.8, 92.1, 93, 94.6],
    split: [35, 29, 19, 17],
  },
};
