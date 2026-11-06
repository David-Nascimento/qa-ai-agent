// QA AI Agent · Rotas por hash e troca de telas
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- Navegação ---------- */
const VIEWS = [
  'dashboard',
  'pipelines',
  'execucoes',
  'aovivo',
  'detalhe',
  'cenarios',
  'analises',
  'agente',
  'integracoes',
  'config',
];
function show(h) {
  let v = h || 'dashboard',
    id = null;
  if (v.startsWith('exec-')) {
    id = v.split('-')[1];
    v = 'detalhe';
  }
  if (!VIEWS.includes(v) || (v === 'detalhe' && !id)) v = 'dashboard';
  if (v === 'agente' && !CFG.ai) {
    if (location.hash.slice(1) !== 'dashboard') location.hash = 'dashboard';
    v = 'dashboard';
  }
  const navKey = v === 'detalhe' || v === 'aovivo' ? 'execucoes' : v;
  $$('#nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === navKey);
    b.toggleAttribute('aria-current', b.dataset.view === navKey);
  });
  VIEWS.forEach(k => ($('#v-' + k).hidden = k !== v));
  const ag = $('#agentPanel'),
    full = v === 'agente';
  (full ? $('#agentSlotFull') : $('#agentSlotDash')).appendChild(ag);
  ag.style.flex = '1';
  $('#agentSuggest').hidden = !full;
  $('#agentSub').textContent = full
    ? 'Converse com o agente e obtenha análises, insights e recomendações.'
    : 'Pergunte sobre suas pipelines, execuções e falhas.';
  ({
    aovivo: () => {
      fillLivePipe();
      renderLive();
    },
    dashboard: renderDashboard,
    pipelines: renderPipes,
    execucoes: renderExecs,
    cenarios: renderScens,
    analises: renderAnalises,
    integracoes: renderInts,
    config: renderCfg,
  })[v]?.();
  if (v === 'detalhe') renderDetail(id);
  if (full) {
    $('#chat').scrollTop = $('#chat').scrollHeight;
    $('#ask').focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}
const go = h => {
  if (location.hash.slice(1) === h) show(h);
  else location.hash = h;
};
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) go(b.dataset.view);
});
addEventListener('hashchange', () => {
  detTab = 'cen';
  show(location.hash.slice(1));
});
function refresh() {
  show(location.hash.slice(1));
}
