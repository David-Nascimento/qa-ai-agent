// QA AI Agent · Cenários lidos do Jira
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 5. Cenários ---------- */
// Cenários vêm do Jira (API REST). Sem servidor, usa os dados de exemplo no mesmo formato.
let JIRA_SYNC = store.get('jiraSync', null);
const scKey = s => s.key || 'QA-' + (100 + (+String(s.id).replace(/\D/g, '') || 0));
const scJira = s => s.js || (s.s === 'Inativo' ? 'Obsoleto' : 'Pronto');
function lastResult(sc) {
  const run = RUNS.find(r => r.p === sc.p && r.s !== 'Cancelada');
  if (!run) return null;
  const id = String(sc.id || '').match(/CT-\d+/)?.[0];
  const list = run.live
    ? run.live.sc.map(x => ({ n: x.n, st: x.st }))
    : suiteFor(run).map(x => ({ n: x.n, st: x.f ? 'fail' : 'pass' }));
  const hit = list.find(x => (id && x.n.includes(id)) || x.n.includes(sc.name));
  if (!hit) return null;
  return { run, st: hit.st };
}
function renderScens() {
  fillSelect('#cPipe', 'Todos os componentes', [...new Set(SCENS.map(s => s.p))].sort());
  fillSelect('#cStatus', 'Todos os status do Jira', [...new Set(SCENS.map(scJira))].sort());
  const q = $('#cSearch').value.toLowerCase(),
    pp = $('#cPipe').value,
    st = $('#cStatus').value,
    rs = $('#cRes').value;
  const jUrl = (INTS.find(i => i.k === 'jira') || {}).url || '';
  $('#jiraSrc').innerHTML =
    `<span class="jsrc-l">${svg('<path d="M12 3 21 12l-9 9-9-9z"/>', 16, '#1868db', 2)} <b>Origem: Jira</b></span>
    <code title="Consulta usada na API do Jira">${esc(CFG.jql)}</code>
    <span class="muted">${SCENS.length} cenários${JIRA_SYNC ? ` · atualizado em ${esc(JIRA_SYNC)}` : ' · dados de exemplo'}</span>
    <button type="button" class="link-btn" id="jiraEdit">Editar consulta</button>`;
  const list = SCENS.map(s => ({ s, res: lastResult(s) })).filter(({ s, res }) => {
    const txt = (scKey(s) + ' ' + s.id + ' ' + s.name).toLowerCase();
    const r = !res ? 'Sem execução' : res.st === 'fail' ? 'Falha' : res.st === 'pass' ? 'Sucesso' : 'Executando';
    return txt.includes(q) && (!pp || s.p === pp) && (!st || scJira(s) === st) && (!rs || r === rs);
  });
  $('#scenRows').innerHTML =
    list
      .map(
        ({
          s,
          res,
        }) => `<tr><td>${s.url || jUrl ? `<a class="key" href="${esc(s.url || jUrl.replace(/\/$/, '') + '/browse/' + scKey(s))}" target="_blank" rel="noopener">${esc(scKey(s))}</a>` : `<span class="key">${esc(scKey(s))}</span>`}</td>
    <td><span class="muted">${esc(s.id || '')}</span> ${esc(s.name)}</td><td>${esc(s.p || '—')}</td>
    <td><span class="jst ${scJira(s) === 'Obsoleto' ? 'off' : scJira(s) === 'Pronto' ? 'ok' : 'wip'}">${esc(scJira(s))}</span></td>
    <td>${!res ? '<span class="muted">Sem execução</span>' : `${pill(res.st === 'fail' ? 'Falha' : res.st === 'pass' ? 'Sucesso' : res.st === 'run' ? 'Executando' : 'Pendente')} <a class="muted" href="#exec-${res.run.id}">#${res.run.id}</a>`}</td></tr>`
      )
      .join('') || '<tr><td colspan="5" class="empty">Nenhum cenário encontrado.</td></tr>';
}
async function syncJira() {
  if (!API) {
    JIRA_SYNC = new Date().toLocaleString('pt-BR');
    store.set('jiraSync', JIRA_SYNC);
    renderScens();
    toast('Sem servidor conectado: mostrando os cenários de exemplo.');
    return;
  }
  try {
    const r = await fetch(
      `${API}/api/jira/scenarios?jql=${encodeURIComponent(CFG.jql)}&field=${encodeURIComponent(CFG.jiraField)}`,
      { headers: API_KEY ? { 'x-api-key': API_KEY } : {} }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    SCENS = d.scenarios.map(x => ({
      key: x.key,
      id: (x.name.match(/CT-\d+/) || [''])[0],
      name: x.name.replace(/^CT-\d+\s*[-–:]?\s*/, ''),
      p: x.pipeline || '—',
      js: x.status,
      url: x.url,
    }));
    JIRA_SYNC = new Date().toLocaleString('pt-BR');
    store.set('jiraSync', JIRA_SYNC);
    saveData();
    renderScens();
    toast(`${SCENS.length} cenários carregados do Jira`);
  } catch (e) {
    toast(`Não foi possível ler o Jira: ${e.message}`);
  }
}
$('#jiraSync').addEventListener('click', syncJira);
$('#v-cenarios').addEventListener('click', e => {
  if (e.target.id !== 'jiraEdit') return;
  modal(
    'Consulta dos cenários no Jira',
    `<div class="field"><label for="jq1">Consulta (JQL) enviada à API do Jira</label><textarea id="jq1" name="jql" required>${esc(CFG.jql)}</textarea><small>JQL é a linguagem de busca da própria API do Jira (endpoint de busca de issues). Ex.: project = QA AND issuetype = Test AND labels = automatizado</small></div>
   <div class="field"><label for="jq2">Campo do Jira que indica o componente (pipeline)</label><input id="jq2" name="field" value="${esc(CFG.jiraField)}"><small>components, labels ou um campo personalizado (ex.: customfield_10045)</small></div>`,
    fd => {
      CFG.jql = fd.get('jql').trim();
      CFG.jiraField = fd.get('field').trim() || 'components';
      store.set('cfg', CFG);
      renderScens();
      syncJira();
    }
  );
});
['#cSearch', '#cPipe', '#cStatus', '#cRes'].forEach(s => $(s).addEventListener('input', renderScens));
