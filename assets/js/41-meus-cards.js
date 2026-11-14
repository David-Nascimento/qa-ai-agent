// QA AI Agent · Meus cards (Jira)
// Cards do projeto atribuídos a quem gerou o token do Jira no servidor (assignee = currentUser()):
// abertos e os concluídos nos últimos dias. O servidor guarda um cache curto; aqui só se exibe.
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

const MINE_COLS = [
  ['new', 'A fazer'],
  ['indeterminate', 'Em andamento'],
  ['done', 'Concluídos'],
];
// Sem servidor conectado: exemplos no mesmo formato, para ver como a área fica
const dMine = n => new Date(Date.now() + n * 86400000).toISOString();
const MINE_SAMPLE = {
  me: 'Exemplo',
  sample: true,
  days: 7,
  at: Date.now(),
  cards: [
    ['QA-142', 'Automatizar fluxo de checkout com cupom', 'Em andamento', 'indeterminate', 'High', 'Task', -1, 2],
    ['QA-151', 'Investigar falha intermitente no pagamento', 'Em andamento', 'indeterminate', 'Highest', 'Bug', 0, -1],
    ['QA-155', 'Revisar cenários de cadastro', 'A fazer', 'new', 'Medium', 'Task', -3, 5],
    ['QA-158', 'Criar ciclo de regressão da release 3.9', 'A fazer', 'new', 'Medium', 'Story', -2, 9],
    ['QA-131', 'Corrigir timeout no teste de login', 'Concluído', 'done', 'High', 'Bug', -2, null],
  ].map(([key, summary, status, category, priority, type, upd, due]) => ({
    key,
    summary,
    status,
    category,
    priority,
    type,
    updated: dMine(upd),
    due: due == null ? '' : dMine(due).slice(0, 10),
    resolved: category === 'done' ? dMine(upd) : '',
    url: '',
  })),
};
let MINE = null; // última resposta do servidor
let MINE_ERR = '';
let MINE_BUSY = false;

const agoMine = t => {
  const m = Math.floor((Date.now() - Date.parse(t)) / 60000);
  if (!(m >= 0)) return '';
  return m < 1
    ? 'agora'
    : m < 60
      ? `há ${m} min`
      : m < 1440
        ? `há ${Math.floor(m / 60)} h`
        : `há ${Math.floor(m / 1440)} d`;
};
const isLate = c => c.category !== 'done' && c.due && c.due < new Date().toISOString().slice(0, 10);
// só endereços http(s) viram link: o texto do Jira nunca decide o destino
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const PRIO_CLS = { highest: 'fail', high: 'fail', medium: 'run', low: 'off', lowest: 'off' };

function mineCard(c) {
  const key = safeUrl(c.url)
    ? `<a class="mc-key" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.key)}</a>`
    : `<span class="mc-key">${esc(c.key)}</span>`;
  const late = isLate(c);
  return `<li class="mc"><div class="mc-top">${key}${c.type ? `<span class="mc-type">${esc(c.type)}</span>` : ''}</div>
    <p class="mc-sum">${esc(c.summary)}</p>
    <div class="mc-meta">${c.priority ? `<span class="pill sm ${PRIO_CLS[c.priority.toLowerCase()] || 'off'}">${esc(c.priority)}</span>` : ''}
    <span class="mc-st">${esc(c.status)}</span>
    ${c.due ? `<span class="mc-due${late ? ' late' : ''}" title="Data de entrega">${late ? 'Atrasado · ' : 'Entrega '}${esc(c.due.split('-').reverse().join('/'))}</span>` : ''}
    <span class="mc-up">${c.category === 'done' && c.resolved ? 'concluído ' + agoMine(c.resolved) : 'atualizado ' + agoMine(c.updated)}</span></div></li>`;
}

function renderMeus() {
  const d = MINE || (API ? null : MINE_SAMPLE);
  const note = $('#mineNote');
  if (!d) {
    $('#mineSum').innerHTML = '';
    $('#mineBoard').innerHTML = '';
    note.textContent = MINE_ERR || (MINE_BUSY ? 'Carregando seus cards do Jira…' : '');
    note.className = 'jsrc' + (MINE_ERR ? ' err' : '');
    return;
  }
  const by = k => d.cards.filter(c => c.category === k);
  const late = d.cards.filter(isLate).length;
  const open = d.cards.length - by('done').length;
  $('#mineSum').innerHTML =
    `<div class="mine-stat"><b>${open}</b><span>abertos</span></div>` +
    `<div class="mine-stat"><b>${by('indeterminate').length}</b><span>em andamento</span></div>` +
    `<div class="mine-stat${late ? ' late' : ''}"><b>${late}</b><span>atrasados</span></div>` +
    `<div class="mine-stat"><b>${by('done').length}</b><span>concluídos em ${d.days || 7} dias</span></div>`;
  note.className = 'jsrc' + (MINE_ERR ? ' err' : '');
  note.textContent = MINE_ERR
    ? `${MINE_ERR} Mostrando os dados anteriores.`
    : d.sample
      ? 'Exemplo: conecte o servidor com o Jira configurado para ver os seus cards de verdade.'
      : `Cards atribuídos a ${d.me || 'quem gerou o token do Jira'}${d.demo ? ' (demonstração)' : ''} · atualizado ${agoMine(new Date(d.at).toISOString())}`;
  $('#mineBoard').innerHTML = MINE_COLS.map(([k, t]) => {
    const l = by(k);
    return `<section class="mine-col" aria-label="${t}"><h2>${t}<span>${l.length}</span></h2>${
      l.length ? `<ul>${l.map(mineCard).join('')}</ul>` : '<p class="mine-empty">Nenhum card</p>'
    }</section>`;
  }).join('');
}

async function loadMine(force = false) {
  if (!API || MINE_BUSY) return renderMeus();
  MINE_BUSY = true;
  const btn = $('#mineRefresh');
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/api/jira/mine${force ? '?refresh=1' : ''}`, { headers: jiraHeaders() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `erro ${r.status}`);
    MINE = d;
    MINE_ERR = '';
  } catch (e) {
    MINE_ERR = `Não foi possível ler seus cards: ${e.message}.`;
  } finally {
    MINE_BUSY = false;
    btn.disabled = false;
    renderMeus();
  }
}
// ao abrir a tela, atualiza se os dados têm mais de 1 minuto (o servidor ainda segura o limite do Jira)
function openMeus() {
  renderMeus();
  if (API && (!MINE || Date.now() - MINE.at > 60000)) loadMine();
}
$('#mineRefresh').addEventListener('click', () =>
  API ? loadMine(true) : toast('Sem servidor conectado: mostrando exemplos.')
);
setInterval(() => {
  if (!$('#v-meus').hidden && (MINE || !API)) renderMeus(); // mantém os "há X min" em dia
}, 60000);
