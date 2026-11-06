// QA AI Agent · Análises › Tempo de execução (plataforma, projeto, componente, CSV)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- Análises › Tempo de execução (uma única visão: plataforma, projeto, componente e auditoria) ---------- */
const AUF = { proj: '', tech: '', active: true };
const TF = new Set(); // componentes escolhidos no filtro (vazio = todos)
const secs = n => Math.round(n).toLocaleString('pt-BR') + 's';
function renderTempo() {
  const act = PIPES.filter(p => p.active !== false);
  const byG = [...new Set(act.map(p => p.group))]
    .map(
      g =>
        `<div class="cf-g"><b>${esc(g)}</b>${act
          .filter(p => p.group === g)
          .map(
            p =>
              `<label><input type="checkbox" value="${esc(p.name)}" ${!TF.size || TF.has(p.name) ? 'checked' : ''}> ${esc(p.name)} ${techBadge(p.tech)}</label>`
          )
          .join('')}</div>`
    )
    .join('');
  $('#aBody').innerHTML = `<div id="tempoRoot"><div id="auditRoot">
   <div class="toolbar">
     <div class="sel"><select id="auProj" aria-label="Projeto"><option value="">Todos os projetos</option>${groups()
       .map(g => `<option ${AUF.proj === g ? 'selected' : ''}>${esc(g)}</option>`)
       .join('')}</select></div>
     <div class="sel"><select id="auTech" aria-label="Plataforma"><option value="">Todas as plataformas</option>${TECHS.map(t => `<option ${AUF.tech === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
     <details class="cf" id="techFilter"><summary id="techFilterLabel"></summary><div class="cf-pop"><div class="cf-act"><button type="button" class="btn-out" data-tf="all">Selecionar todos</button><button type="button" class="btn-out" data-tf="none">Limpar</button></div>${byG}</div></details>
     <label class="switch-inline"><input type="checkbox" id="auActive" ${AUF.active ? 'checked' : ''}> Somente ativos</label>
     <button type="button" class="btn-out" id="auCopy" style="margin-left:auto">Copiar relatório (CSV)</button>
   </div>
   <div class="tgrid" id="tmCards"></div>
   <details class="how"><summary>Como os tempos são calculados</summary><div>
     <p><b>Média da plataforma</b>: média própria de cada plataforma, igual à soma das durações das execuções concluídas dela no período ÷ nº de execuções dela. Não é derivada do total.</p>
     <p><b>Tempo total atual</b>: soma da execução mais recente de cada componente filtrado (um ciclo completo).</p>
     <p><b>Δ</b>: tempo total atual comparado com a soma das médias dos mesmos componentes.</p>
     <p><b>Ao vivo</b>: componentes rodando agora e o tempo decorrido; entram no total quando terminam.</p></div></details>
   <div class="table-wrap"><table class="au-table"><thead><tr><th>Componente</th><th>Plataforma</th><th>Agora</th><th>Última execução</th><th>Tempo mais recente</th><th>Média</th><th>Δ</th></tr></thead><tbody id="auRows"></tbody></table></div>
  </div></div>`;
  updateTempo();
}
function auditData() {
  const [lim] = periodRange(+$('#aPeriod').value);
  return PIPES.filter(
    p =>
      (!AUF.proj || p.group === AUF.proj) &&
      (!AUF.tech || p.tech === AUF.tech) &&
      (!AUF.active || p.active !== false) &&
      (!TF.size || TF.has(p.name))
  )
    .sort((a, b) => a.group.localeCompare(b.group, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR'))
    .map(p => {
      const hist = RUNS.filter(r => r.p === p.name && (r.s === 'Sucesso' || r.s === 'Falha') && r.at >= lim);
      const n = hist.length,
        sum = hist.reduce((a, r) => a + r.d, 0),
        avg = n ? sum / n : p.dur,
        last = hist[0] || null;
      const live = LIVE.find(r => r.p === p.name && r.s === 'Executando');
      return {
        p,
        n,
        sum,
        avg,
        last,
        live,
        el: live ? live.live.el : 0,
        delta: last && avg ? (last.d / avg - 1) * 100 : null,
      };
    });
}
function tempoCard(label, cls, rows) {
  if (!rows.length)
    return `<div class="tcard ${cls} t-empty"><div class="tc-top">${label}</div><p class="an-note">Nenhum componente no filtro.</p></div>`;
  const n = rows.reduce((a, r) => a + r.n, 0),
    sum = rows.reduce((a, r) => a + r.sum, 0),
    avg = n ? sum / n : 0;
  const done = rows.filter(r => r.last),
    cur = done.reduce((a, r) => a + r.last.d, 0),
    ref = done.reduce((a, r) => a + r.avg, 0),
    d = ref ? Math.round((cur / ref - 1) * 100) : 0;
  const run = rows.filter(r => r.live),
    runEl = run.reduce((a, r) => a + r.el, 0);
  return `<div class="tcard ${cls}"><div class="tc-top">${label}<span class="tc-sub">${rows.length} comp.</span></div>
    <div class="tc-v" title="${secs(sum)} ÷ ${n} execuções">${n ? fmtDur(Math.round(avg)) : '—'}</div><div class="tc-l">média por execução · ${n} exec.</div>
    <div class="tc-row" title="Soma da execução mais recente de cada componente, comparada com a soma das médias deles"><span>Total atual <b>${fmtDur(Math.round(cur))}</b></span>${done.length ? `<span class="delta ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : ''}${d}%</span>` : ''}</div>
    <div class="tc-live ${run.length ? 'on' : ''}">${run.length ? `<span class="live-dot"></span>${run.length} rodando · ${fmtDur(Math.round(runEl))}` : 'Nenhum rodando agora'}</div></div>`;
}
function updateTempo() {
  if (!$('#tempoRoot')) return;
  const act = PIPES.filter(p => p.active !== false),
    selN = act.filter(p => !TF.size || TF.has(p.name)).length;
  $('#techFilterLabel').innerHTML =
    `${svg('<path d="M4 5h16l-6 8v5l-4 2v-7z"/>', 16, 'currentColor', 1.8)} Componentes: <b>${!TF.size || selN === act.length ? 'Todos' : selN}</b>`;
  const rows = auditData();
  $('#tmCards').innerHTML =
    tempoCard('<span class="tech all">Todas</span>', 't-all', rows) +
    TECHS.filter(t => !AUF.tech || AUF.tech === t)
      .map(t =>
        tempoCard(
          techBadge(t),
          't-' + techCls(t),
          rows.filter(r => r.p.tech === t)
        )
      )
      .join('');
  $('#tmCards').style.gridTemplateColumns = AUF.tech ? 'repeat(2,minmax(0,1fr))' : '';
  const groupsIn = [...new Set(rows.map(r => r.p.group))];
  const dcell = d =>
    d === null ? '—' : `<span class="delta ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : ''}${Math.round(d)}%</span>`;
  const sumRow = (rs, label, cls) => {
    const n = rs.reduce((a, r) => a + r.n, 0),
      s = rs.reduce((a, r) => a + r.sum, 0),
      done = rs.filter(r => r.last),
      cur = done.reduce((a, r) => a + r.last.d, 0),
      ref = done.reduce((a, r) => a + r.avg, 0);
    return `<tr class="${cls}"><td colspan="4">${label}</td><td>${fmtDur(Math.round(cur))}<small class="calc">soma dos mais recentes</small></td><td>${fmtDur(Math.round(ref))}<small class="calc">soma das médias</small></td><td>${ref ? dcell((cur / ref - 1) * 100) : '—'}</td></tr>`;
  };
  $('#auRows').innerHTML =
    groupsIn
      .map(g => {
        const rs = rows.filter(r => r.p.group === g);
        return (
          `<tr class="grp"><td colspan="7">${esc(g)}</td></tr>` +
          rs
            .map(
              r => `<tr${r.live ? ' class="is-live"' : ''}><td><b style="color:var(--fg)">${esc(r.p.name)}</b>${r.p.active === false ? ' <span class="muted">(inativo)</span>' : ''}</td><td>${techBadge(r.p.tech)}</td>
      <td>${r.live ? `<span class="pill run"><span class="live-dot"></span> ${fmtDur(Math.round(r.el))}</span>` : '<span class="muted">—</span>'}</td>
      <td>${r.last ? `<span class="muted">#${r.last.id} · ${fmtDate(r.last.at)}</span>` : '<span class="muted">sem execução</span>'}</td>
      <td><b>${r.last ? fmtDur(r.last.d) : '—'}</b></td>
      <td>${fmtDur(Math.round(r.avg))}<small class="calc">${r.n ? `${secs(r.sum)} ÷ ${r.n}` : 'referência'}</small></td><td>${dcell(r.delta)}</td></tr>`
            )
            .join('') +
          (rs.length > 1 ? sumRow(rs, `Subtotal ${esc(g)}`, 'sub') : '')
        );
      })
      .join('') +
    (rows.length
      ? sumRow(rows, `Total · ${rows.length} componente${rows.length === 1 ? '' : 's'}`, 'total')
      : '<tr><td colspan="7" class="empty">Nenhum componente para os filtros escolhidos.</td></tr>');
}
const updateTech = updateTempo,
  updateAudit = updateTempo;
function auditCsv() {
  const rows = auditData(),
    q = v => `"${String(v).replace(/"/g, '""')}"`;
  const head = [
    'Projeto',
    'Componente',
    'Plataforma',
    'Status',
    'Execuções no período',
    'Soma das durações (s)',
    'Média (s)',
    'Execução mais recente',
    'Tempo mais recente (s)',
    'Delta vs média (%)',
  ];
  const lines = rows.map(r => [
    r.p.group,
    r.p.name,
    r.p.tech,
    r.live ? 'Executando' : r.p.active === false ? 'Inativo' : 'Ativo',
    r.n,
    Math.round(r.sum),
    Math.round(r.avg),
    r.last ? '#' + r.last.id : '',
    r.last ? Math.round(r.last.d) : '',
    r.delta === null ? '' : Math.round(r.delta),
  ]);
  TECHS.forEach(t => {
    const rs = rows.filter(r => r.p.tech === t),
      n = rs.reduce((a, r) => a + r.n, 0),
      s = rs.reduce((a, r) => a + r.sum, 0);
    if (rs.length)
      lines.push([
        'MÉDIA DA PLATAFORMA',
        '',
        t,
        '',
        n,
        Math.round(s),
        n ? Math.round(s / n) : '',
        '',
        Math.round(rs.reduce((a, r) => a + (r.last ? r.last.d : 0), 0)),
        '',
      ]);
  });
  return [
    `# Tempo de execução · ${$('#aPeriod').selectedOptions[0].textContent} · projeto: ${AUF.proj || 'todos'} · plataforma: ${AUF.tech || 'todas'} · componentes: ${TF.size ? [...TF].filter(x => x !== '__nenhum__').join(', ') || 'nenhum' : 'todos'} · gerado em ${simNow().toLocaleString('pt-BR')}`,
    head.map(q).join(';'),
    ...lines.map(l => l.map(q).join(';')),
  ].join('\n');
}
$('#aBody').addEventListener('input', e => {
  if (!e.target.closest('#auditRoot') || e.target.closest('#techFilter')) return;
  AUF.proj = $('#auProj').value;
  AUF.tech = $('#auTech').value;
  AUF.active = $('#auActive').checked;
  updateTempo();
});
$('#aBody').addEventListener('change', e => {
  const box = e.target.closest('#techFilter');
  if (!box || e.target.type !== 'checkbox') return;
  const all = [...box.querySelectorAll('input[type=checkbox]')],
    on = all.filter(i => i.checked).map(i => i.value);
  TF.clear();
  if (on.length !== all.length) (on.length ? on : ['__nenhum__']).forEach(v => TF.add(v));
  updateTempo();
});
$('#aBody').addEventListener('click', e => {
  const b = e.target.closest('[data-tf]');
  if (b) {
    document.querySelectorAll('#techFilter input[type=checkbox]').forEach(i => (i.checked = b.dataset.tf === 'all'));
    TF.clear();
    if (b.dataset.tf === 'none') TF.add('__nenhum__');
    updateTempo();
    return;
  }
  if (e.target.id !== 'auCopy') return;
  const csv = auditCsv();
  const fallback = () => {
    $('#modalBox').innerHTML =
      `<div class="mrow"><h3 id="mTitle">Relatório (CSV)</h3><button class="close" data-close aria-label="Fechar">×</button></div><p style="margin:0 0 10px;color:var(--muted)">Selecione e copie o texto abaixo.</p><textarea readonly style="width:100%;height:260px;font-family:var(--mono);font-size:12px" id="csvBox">${esc(csv)}</textarea>`;
    $('#modal').hidden = false;
    $('#csvBox').select();
  };
  try {
    navigator.clipboard
      .writeText(csv)
      .then(() => toast('Relatório copiado. Cole no Excel ou no Google Planilhas.'), fallback);
  } catch (_) {
    fallback();
  }
});
document.addEventListener('click', e => {
  const d = $('#techFilter');
  if (d && d.open && !e.target.closest('#techFilter')) d.open = false;
});
$('#aTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-t]');
  if (b) {
    aTab = b.dataset.t;
    renderAnalises();
  }
});
$('#aPeriod').addEventListener('change', renderAnalises);
