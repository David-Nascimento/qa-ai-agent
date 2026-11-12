// QA AI Agent · Utilitários, ícones e menu lateral
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)];
const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = n => n.toFixed(1).replace('.', ',') + '%';
const fmtDur = s => {
  s = Math.round(+s || 0);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('qa:' + k);
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('qa:' + k, JSON.stringify(v));
    } catch (e) {}
  },
};

/* Ícones */
const I = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  pipe: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2v9.6M6 12h5a5 5 0 0 0 5-5V7M8 19h3a5 5 0 0 0 5-5"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z"/>',
  scen: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  chart:
    '<path d="M4 20h16"/><rect x="5" y="11" width="3" height="7"/><rect x="10.5" y="5" width="3" height="13"/><rect x="16" y="8" width="3" height="10"/>',
  spark:
    '<path d="M10 3.5 11.6 8 16 9.6 11.6 11.2 10 15.7 8.4 11.2 4 9.6 8.4 8z"/><path d="M17.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM17 3l.6 1.4L19 5l-1.4.6L17 7l-.6-1.4L15 5l1.4-.6z"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
};
const svg = (p, sz = 24, col = 'currentColor', w = 1.8) =>
  `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO_BOX =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b4bdb" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/></svg>';
const ICO_USER =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b4bdb" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4.5 21c1-4 4-6 7.5-6s6.5 2 7.5 6"/></svg>';
const ICO_SEARCH =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b4bdb" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="11.5" cy="11.5" r="3.5"/><path d="m14.5 14.5 2.5 2.5" stroke-linecap="round"/></svg>';
const ICO_LOCK =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b4bdb" stroke-width="2"><rect x="5" y="10" width="14" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const KEBAB =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="#2a2b3f"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';

const NAV = [
  ['dashboard', 'Dashboard', 'home'],
  ['pipelines', 'Pipelines', 'pipe'],
  ['execucoes', 'Execuções', 'play'],
  ['cenarios', 'Cenários', 'scen'],
  ['analises', 'Análises', 'chart'],
  ['agente', 'Agente de QA', 'spark'],
  null,
  ['integracoes', 'Integrações', 'plug'],
  ['config', 'Configurações', 'gear'],
];
$('#nav').innerHTML = NAV.map(n =>
  n
    ? `<button data-view="${n[0]}" aria-label="${n[1]}">${svg(I[n[2]], 24, 'currentColor', n[2] === 'spark' ? 1.6 : 1.8)}${n[1]}</button>`
    : '<div class="nav-sep"></div>'
).join('');

$('[data-view="execucoes"]').insertAdjacentHTML('beforeend', '<span class="nav-live" id="liveCount" hidden></span>');
