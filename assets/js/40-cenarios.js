// QA AI Agent · Cenários lidos do Jira
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 5. Cenários ---------- */
// Cenários vêm do Jira (API REST). Sem servidor, usa os dados de exemplo no mesmo formato.
// Os ciclos de teste (Zephyr Scale) vêm do servidor, que sincroniza o Jira de tempos em tempos.
let JIRA_SYNC = store.get('jiraSync', null);
let JIRA_STATE = null; // { at, error } da última sincronização feita pelo servidor
const CYC_LBL = { pass: 'Sucesso', fail: 'Falha', blocked: 'Bloqueado', run: 'Executando', pend: 'Não executado' };
const CYC_CLS = { pass: 'pass', fail: 'fail', run: 'run', blocked: 'off', pend: 'off' };
const cycPill = st => `<span class="pill sm ${CYC_CLS[st] || 'off'}">${CYC_LBL[st] || esc(st)}</span>`;
// Lista de ciclos: do servidor (CYCLES_SRV) ou, sem servidor, os de exemplo.
// API só existe depois (90-tempo-real.js), por isso é lida dentro da função e não na carga.
const CYCLES_SAMPLE = CYCLES_DEMO.map(c => {
  const totals = { total: 0, pass: 0, fail: 0, blocked: 0, run: 0, pend: 0, unlinked: 0 };
  Object.values(c.items).forEach(st => (totals.total++, totals[st]++));
  return { ...c, totals };
});
let CYCLES_SRV = null;
const cycleList = () => CYCLES_SRV ?? (API ? [] : CYCLES_SAMPLE);
// Em quais ciclos o cenário aparece e com qual resultado
const cyclesOf = s =>
  s.cycles ||
  (API ? [] : CYCLES_DEMO.filter(c => c.items[s.id]).map(c => ({ key: c.key, name: c.name, status: c.items[s.id] })));
const scKey = s => s.key || 'QA-' + (100 + (+String(s.id).replace(/\D/g, '') || 0));
const scJira = s => s.js || (s.s === 'Inativo' ? 'Obsoleto' : 'Pronto');
function lastResult(sc) {
  const run = RUNS.find(r => r.p === sc.p && r.s !== 'Cancelada');
  if (!run) return null;
  const id = String(sc.id || '').match(/CT-\d+/)?.[0];
  const list = run.live
    ? run.live.sc.map(x => ({ n: x.n, st: x.st }))
    : suiteFor(run).map(x => ({ n: x.n, st: x.f ? 'fail' : 'pass' }));
  const hit = list.find(x => (id && x.n.includes(id)) || (sc.name && x.n.includes(sc.name)));
  if (!hit) return null;
  return { run, st: hit.st };
}
// "há 3 min" a partir da última sincronização do servidor
function jiraAge() {
  const t = JIRA_STATE?.at;
  if (!t) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? 'agora há pouco' : m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h`;
}
function fillCycles() {
  const el = $('#cCycle'),
    v = el.value;
  el.innerHTML =
    '<option value="">Todos os ciclos</option>' +
    cycleList()
      .map(c => `<option value="${esc(c.key)}">${esc(c.key)} · ${esc(c.name)}</option>`)
      .join('');
  el.value = cycleList().some(c => c.key === v) ? v : '';
  $('#cCycleBox').hidden = !cycleList().length;
  $('#thCycle').hidden = !cycleList().length;
}
// Resumo do ciclo selecionado: contagem por resultado e casos sem cenário no Jira
function cycleSummary(c) {
  const box = $('#cycSum');
  box.hidden = !c;
  if (!c) return;
  const t = c.totals;
  box.innerHTML = `<span class="jsrc-l"><b>${esc(c.name)}</b></span>
    <span class="muted">${esc(c.key)} · ${esc(c.status || '—')}${c.folder ? ' · ' + esc(c.folder) : ''}</span>
    ${['pass', 'fail', 'blocked', 'run', 'pend']
      .filter(k => t[k])
      .map(k => `<span class="cyc">${cycPill(k)} <b>${t[k]}</b></span>`)
      .join('')}
    ${t.unlinked ? `<span class="muted" title="Casos do ciclo que não aparecem entre os cenários carregados">${t.unlinked} sem cenário no Jira</span>` : ''}
    ${c.url && API ? `<a class="link-btn" href="${esc(c.url)}" target="_blank" rel="noopener">Abrir no Jira</a>` : ''}`;
}
function renderScens() {
  fillSelect('#cPipe', 'Todos os componentes', [...new Set(SCENS.map(s => s.p))].sort());
  fillSelect('#cStatus', 'Todos os status do Jira', [...new Set(SCENS.map(scJira))].sort());
  fillCycles();
  const q = $('#cSearch').value.toLowerCase(),
    pp = $('#cPipe').value,
    st = $('#cStatus').value,
    rs = $('#cRes').value,
    cy = $('#cCycle').value;
  const jUrl = (INTS.find(i => i.k === 'jira') || {}).url || '';
  const when = JIRA_STATE?.at
    ? ` · sincronizado <span id="jiraAge">${jiraAge()}</span>${JIRA_STATE.error ? ` <span class="jst wip" title="${esc(JIRA_STATE.error)}">· última tentativa falhou; mostrando os dados anteriores</span>` : ''}`
    : JIRA_SYNC
      ? ` · atualizado em ${esc(JIRA_SYNC)}`
      : ' · dados de exemplo';
  $('#jiraSrc').innerHTML =
    `<span class="jsrc-l">${svg('<path d="M12 3 21 12l-9 9-9-9z"/>', 16, '#1868db', 2)} <b>Origem: Jira</b></span>
    <code title="Consulta usada na API do Jira">${esc(CFG.jql)}</code>
    <span class="muted">${SCENS.length} cenários${when}</span>
    <button type="button" class="link-btn" id="jiraEdit">Editar consulta</button>`;
  cycleSummary(cycleList().find(c => c.key === cy));
  const list = SCENS.map(s => ({ s, res: lastResult(s) })).filter(({ s, res }) => {
    const txt = (scKey(s) + ' ' + s.id + ' ' + s.name).toLowerCase();
    const r = !res
      ? 'Sem execução'
      : res.st === 'fail'
        ? 'Falha'
        : res.st === 'pass'
          ? 'Sucesso'
          : res.st === 'run'
            ? 'Executando'
            : 'Pendente';
    return (
      txt.includes(q) &&
      (!pp || s.p === pp) &&
      (!st || scJira(s) === st) &&
      (!rs || r === rs) &&
      (!cy || cyclesOf(s).some(c => c.key === cy))
    );
  });
  // Coluna de ciclos: com um ciclo escolhido mostra o resultado nele; senão, os ciclos em que o cenário aparece
  const cycCell = s => {
    const cs = cyclesOf(s);
    if (cy) return cycPill(cs.find(c => c.key === cy)?.status);
    if (!cs.length) return '<span class="muted">—</span>';
    const more = cs.slice(1);
    return (
      `<span class="cyc" title="${esc(cs[0].name)}"><b>${esc(cs[0].key)}</b> ${cycPill(cs[0].status)}</span>` +
      (more.length
        ? `<span class="muted" title="${esc(more.map(c => c.key + ' · ' + (CYC_LBL[c.status] || c.status)).join('\n'))}">+${more.length}</span>`
        : '')
    );
  };
  const cols = cycleList().length ? 6 : 5;
  $('#scenRows').innerHTML =
    list
      .map(
        ({
          s,
          res,
        }) => `<tr><td>${s.url || jUrl ? `<a class="key" href="${esc(s.url || jUrl.replace(/\/$/, '') + '/browse/' + scKey(s))}" target="_blank" rel="noopener">${esc(scKey(s))}</a>` : `<span class="key">${esc(scKey(s))}</span>`}</td>
    <td><span class="muted">${esc(s.id || '')}</span> ${esc(s.name)}</td><td>${esc(s.p || '—')}</td>
    <td><span class="jst ${scJira(s) === 'Obsoleto' ? 'off' : scJira(s) === 'Pronto' ? 'ok' : 'wip'}">${esc(scJira(s))}</span></td>
    <td>${!res ? '<span class="muted">Sem execução</span>' : `${pill(res.st === 'fail' ? 'Falha' : res.st === 'pass' ? 'Sucesso' : res.st === 'run' ? 'Executando' : 'Pendente')} <a class="muted" href="#exec-${res.run.id}">#${runNo(res.run)}</a>`}</td>
    ${cycleList().length ? `<td>${cycCell(s)}</td>` : ''}</tr>`
      )
      .join('') || `<tr><td colspan="${cols}" class="empty">Nenhum cenário encontrado.</td></tr>`;
}

/* ---------- Dados vindos do servidor ---------- */
const jiraHeaders = () => (API_KEY ? { 'x-api-key': API_KEY } : {});
const toScen = x => ({
  key: x.key,
  id: (x.name.match(/CT-\d+/) || [''])[0],
  name: x.name.replace(/^CT-\d+\s*[-–:]?\s*/, ''),
  p: x.pipeline || '—',
  js: x.status,
  url: x.url,
  case: x.caseKey || '',
  cycles: x.cycles || [],
});
// Só os ciclos: usado quando a pessoa editou a consulta e os cenários vêm de outra busca
function mergeCycles(d) {
  const m = new Map((d.scenarios || []).map(x => [x.key, x]));
  SCENS.forEach(s => {
    const x = m.get(scKey(s));
    s.case = x?.caseKey || '';
    s.cycles = x?.cycles || [];
  });
}
// Enquanto a pessoa não editar a consulta, vale a do servidor (JIRA_SCENARIOS_JQL / JIRA_PIPELINE_FIELD)
function adoptServerQuery(d) {
  if (CFG.jqlCustom || (d.jql === CFG.jql && d.field === CFG.jiraField)) return;
  CFG.jql = d.jql;
  CFG.jiraField = d.field;
  store.set('cfg', CFG);
}
// Aplica o estado em cache do servidor (cenários + ciclos). Os cenários só são trocados quando a
// consulta e o campo são os mesmos do servidor; se a pessoa editou a consulta, entram só os ciclos.
function applyJiraState(d) {
  adoptServerQuery(d);
  CYCLES_SRV = d.cycles || [];
  JIRA_STATE = { at: d.syncedAt, error: d.error };
  if (d.syncedAt) {
    JIRA_SYNC = new Date(d.syncedAt).toLocaleString('pt-BR');
    store.set('jiraSync', JIRA_SYNC);
  }
  if (d.jql === CFG.jql && d.field === CFG.jiraField && d.scenarios.length) {
    SCENS = d.scenarios.map(toScen);
    saveData();
  } else mergeCycles(d);
  renderScens();
}
async function jiraApi(path, method = 'GET') {
  const r = await fetch(API + path, { method, headers: jiraHeaders() });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}
// Leitura silenciosa (ao conectar e a cada aviso "jira_sync" do servidor): não chama o Jira, só o cache
async function loadJiraState() {
  try {
    applyJiraState(await jiraApi('/api/jira/state'));
  } catch {
    /* Jira não configurado no servidor: segue com os dados atuais */
  }
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
    // O servidor limita a atualização manual (1 a cada 30 s) para não esgotar o limite do Jira
    const st = await jiraApi('/api/jira/sync', 'POST');
    adoptServerQuery(st);
    if (st.jql !== CFG.jql || st.field !== CFG.jiraField) {
      // consulta editada pela pessoa: busca na hora e depois liga os ciclos pela chave
      const d = await jiraApi(
        `/api/jira/scenarios?jql=${encodeURIComponent(CFG.jql)}&field=${encodeURIComponent(CFG.jiraField)}`
      );
      SCENS = d.scenarios.map(toScen);
      saveData();
    }
    applyJiraState(st);
    toast(
      st.throttled
        ? `Já atualizado ${jiraAge()}. O servidor sincroniza com o Jira sozinho a cada poucos minutos.`
        : `${SCENS.length} cenários carregados do Jira`
    );
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
      CFG.jqlCustom = true; // a consulta passa a ser da pessoa, não a do servidor
      store.set('cfg', CFG);
      renderScens();
      syncJira();
    }
  );
});
['#cSearch', '#cPipe', '#cStatus', '#cRes', '#cCycle'].forEach(s => $(s).addEventListener('input', renderScens));
// o "há X min" acompanha o relógio sem refazer a tela
setInterval(() => {
  const el = $('#jiraAge');
  if (el) el.textContent = jiraAge();
}, 30000);
