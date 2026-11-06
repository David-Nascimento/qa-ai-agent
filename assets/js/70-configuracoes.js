// QA AI Agent · Tela Configurações (inclui o interruptor de IA)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 9. Configurações ---------- */
let CFG = Object.assign(
  {
    ws: 'QA AI Agent',
    lang: 'Português (Brasil)',
    tz: 'America/Fortaleza',
    prov: 'OpenAI',
    model: 'gpt-4o-mini',
    prompt:
      'Você é um especialista em Quality Assurance (QA). Analise dados de execuções, identifique falhas, padrões e forneça recomendações práticas e objetivas.',
    temp: 0.3,
    ret: '90',
    goal: 95,
    alerts: true,
    auto: true,
    weekly: false,
    ai: false,
    jql: 'project = QA AND issuetype = Test AND labels = automatizado ORDER BY key',
    jiraField: 'components',
  },
  store.get('cfg', {})
);
const MODELS = {
  OpenAI: ['gpt-4o-mini', 'gpt-4o'],
  Anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
  'Azure OpenAI': ['gpt-4o-mini (Azure)', 'gpt-4o (Azure)'],
};
let cfgTab = 'ia';
const CFG_TABS = [
  ['geral', 'Geral', I.gear],
  ['ia', 'IA e Prompts', I.spark],
  [
    'dados',
    'Dados',
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
  ],
  [
    'users',
    'Usuários (MVP)',
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/>',
  ],
];
function opt(list, v) {
  return list.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('');
}
function renderCfg() {
  if (!CFG.ai && cfgTab === 'ia') cfgTab = 'geral';
  $('#cfgNav').innerHTML = CFG_TABS.filter(t => CFG.ai || t[0] !== 'ia')
    .map(
      t =>
        `<button type="button" data-cfg="${t[0]}" class="${cfgTab === t[0] ? 'on' : ''}">${svg(t[2], 20, 'currentColor', 1.7)}${t[1]}</button>`
    )
    .join('');
  let body = '';
  if (cfgTab === 'geral')
    body = `<h2>Geral</h2><div class="field"><label for="ws">Nome do workspace</label><input id="ws" value="${esc(CFG.ws)}"></div>
   <div class="f2"><div class="field"><label for="lang">Idioma</label><div class="sel"><select id="lang">${opt(['Português (Brasil)', 'English', 'Español'], CFG.lang)}</select></div></div>
   <div class="field"><label for="tz">Fuso horário</label><div class="sel"><select id="tz">${opt(['America/Fortaleza', 'America/Sao_Paulo', 'America/Manaus', 'UTC'], CFG.tz)}</select></div></div></div>
   <div><div class="switch"><span><b>Alertas de falha</b><br><small>Notificar quando uma pipeline falhar</small></span><input id="alerts" type="checkbox" ${CFG.alerts ? 'checked' : ''}></div>
   <div class="switch"><span><b>Resumo semanal</b><br><small>Relatório de qualidade toda segunda-feira</small></span><input id="weekly" type="checkbox" ${CFG.weekly ? 'checked' : ''}></div></div>
   <div class="ai-flag"><div class="switch" style="border:0"><span><b>Recursos de IA (Agente de QA)</b><br><small>Mostra o menu Agente de QA, o painel do agente no Dashboard, os botões “Analisar com IA” e a aba IA e Prompts. Deixe desligado enquanto as integrações forem só Jenkins e Jira.</small></span><input id="ai" type="checkbox" ${CFG.ai ? 'checked' : ''}></div></div>`;
  else if (cfgTab === 'ia')
    body = `<h2>IA e Prompts</h2>
   <div class="f2"><div class="field"><label for="prov">Provedor de IA</label><div class="sel"><select id="prov">${opt(Object.keys(MODELS), CFG.prov)}</select></div></div>
   <div class="field"><label for="model">Modelo</label><div class="sel"><select id="model">${opt(MODELS[CFG.prov] || [], CFG.model)}</select></div></div></div>
   <div class="field"><label for="prompt">Prompt do Agente</label><textarea id="prompt">${esc(CFG.prompt)}</textarea></div>
   <div class="field"><label for="temp">Temperatura</label><div class="range"><input id="temp" type="range" min="0" max="1" step="0.1" value="${CFG.temp}"><input id="tempN" type="number" min="0" max="1" step="0.1" value="${CFG.temp}" aria-label="Temperatura"></div><small>Valores baixos deixam as análises mais objetivas e consistentes.</small></div>
   <div class="switch"><span><b>Análise automática pela IA</b><br><small>O agente analisa cada falha ao terminar a execução</small></span><input id="auto" type="checkbox" ${CFG.auto ? 'checked' : ''}></div>`;
  else if (cfgTab === 'dados')
    body = `<h2>Dados</h2><div class="f2"><div class="field"><label for="ret">Retenção do histórico</label><div class="sel"><select id="ret">${['30', '90', '180', '365'].map(d => `<option value="${d}" ${CFG.ret === d ? 'selected' : ''}>${d} dias</option>`).join('')}</select></div></div>
   <div class="field"><label for="goal">Meta de taxa de sucesso (%)</label><input id="goal" type="number" min="50" max="100" value="${CFG.goal}"></div></div>
   <div class="field"><label>Dados de exemplo</label><small>Restaura pipelines, cenários e integrações ao estado inicial do esboço.</small><div><button type="button" class="btn-out" id="resetData">Restaurar dados de exemplo</button></div></div>`;
  else
    body = `<h2>Usuários (MVP)</h2><div class="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th></tr></thead><tbody>
   <tr><td><b style="color:var(--fg)">QA</b></td><td>qa@empresa.com</td><td><span class="pill run">Administrador</span></td></tr>
   <tr><td>Ana Souza</td><td>ana.souza@empresa.com</td><td><span class="pill off">Analista</span></td></tr>
   <tr><td>Bruno Lima</td><td>bruno.lima@empresa.com</td><td><span class="pill off">Leitor</span></td></tr></tbody></table></div>
   <small style="color:var(--muted)">Gerenciamento de usuários chega na próxima versão.</small>`;
  $('#cfgForm').innerHTML =
    body +
    `<div class="form-foot"><button class="btn-pri" type="submit">${svg('<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>', 18, '#fff', 1.8)} Salvar configurações</button></div>`;
}
function readCfg() {
  const v = id => {
    const el = document.getElementById(id);
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined;
  };
  ['ws', 'lang', 'tz', 'prov', 'model', 'prompt', 'ret'].forEach(k => {
    const x = v(k);
    if (x !== undefined) CFG[k] = x;
  });
  ['alerts', 'weekly', 'auto', 'ai'].forEach(k => {
    const x = v(k);
    if (x !== undefined) CFG[k] = x;
  });
  if (v('temp') !== undefined) CFG.temp = +v('temp');
  if (v('goal') !== undefined) CFG.goal = +v('goal');
}
$('#cfgNav').addEventListener('click', e => {
  const b = e.target.closest('[data-cfg]');
  if (b) {
    readCfg();
    cfgTab = b.dataset.cfg;
    renderCfg();
  }
});
$('#cfgForm').addEventListener('input', e => {
  if (e.target.id === 'ai') {
    CFG.ai = e.target.checked;
    store.set('cfg', CFG);
    applyAI();
    renderCfg();
    toast(CFG.ai ? 'Recursos de IA ativados' : 'Recursos de IA ocultos');
    return;
  }
  if (e.target.id === 'prov') {
    CFG.prov = e.target.value;
    CFG.model = MODELS[CFG.prov][0];
    $('#model').innerHTML = opt(MODELS[CFG.prov], CFG.model);
  }
  if (e.target.id === 'temp') $('#tempN').value = e.target.value;
  if (e.target.id === 'tempN') $('#temp').value = e.target.value;
});
$('#cfgForm').addEventListener('submit', e => {
  e.preventDefault();
  readCfg();
  store.set('cfg', CFG);
  toast('Configurações salvas');
});
$('#cfgForm').addEventListener('click', e => {
  if (e.target.id === 'resetData') {
    ['pipes', 'pipes2', 'scens', 'ints'].forEach(k => {
      try {
        localStorage.removeItem('qa:' + k);
      } catch (_) {}
    });
    location.reload();
  }
});
