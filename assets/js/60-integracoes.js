// QA AI Agent · Tela Integrações
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 8. Integrações ---------- */
let INTS = store.get('ints', null);
if (INTS && !INTS.find(i => i.k === 'jira')) INTS = null;
INTS = INTS || [
  {
    k: 'azure',
    name: 'Azure DevOps',
    desc: 'Importe execuções de pipelines e resultados.',
    on: true,
    bg: '#e8f1fd',
    fg: '#2f6fd6',
    ic: '<path d="M3 7.5 13 3v18L3 16.5zM13 6l8 3v9l-8 3"/>',
  },
  {
    k: 'gitlab',
    name: 'GitLab CI',
    desc: 'Integração com pipelines e jobs.',
    on: false,
    bg: '#fdeee6',
    fg: '#e2531f',
    ic: '<path d="M12 21 3 13l2-9 3 7h8l3-7 2 9z"/>',
  },
  {
    k: 'jenkins',
    name: 'Jenkins',
    desc: 'Importe execuções automatizadas.',
    on: false,
    bg: '#fbeceb',
    fg: '#c0392b',
    ic: '<circle cx="12" cy="9" r="5"/><path d="M5 21c1-4 3.5-6 7-6s6 2 7 6M10 8.5h.01M14 8.5h.01"/>',
  },
  {
    k: 'jira',
    name: 'Jira',
    desc: 'Abra bugs automaticamente a partir das falhas e vincule cenários às issues.',
    on: false,
    bg: '#e6effc',
    fg: '#1868db',
    ic: '<path d="M12 3 21 12l-9 9-9-9z"/><path d="M12 8.5 15.5 12 12 15.5 8.5 12z"/>',
  },
  {
    k: 'json',
    name: 'Importação de Arquivo (JSON)',
    desc: 'Envie resultados de execuções no formato JSON.',
    on: false,
    bg: '#ebe8fd',
    fg: '#5b4bdb',
    ic: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9.5 13l-1.5 2 1.5 2M14.5 13l1.5 2-1.5 2"/>',
  },
];
function renderInts() {
  $('#ints').innerHTML = INTS.map(
    i => `<div class="card int"><div class="logo" style="background:${i.bg}">${svg(i.ic, 26, i.fg, 1.8)}</div>
   <div class="txt"><b>${i.name}</b><span>${i.desc}</span></div>
   ${i.on ? '<span class="conn">Conectado</span>' : `<button class="btn-out pri" data-int="${i.k}">Configurar</button>`}
   <button class="kebab" data-intmenu="${i.k}" aria-label="Mais opções de ${i.name}">${KEBAB}</button></div>`
  ).join('');
}
