// QA AI Agent · Tela Pipelines (pastas e componentes)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 2. Pipelines ---------- */
function fillSelect(sel, first, opts) {
  const el = $(sel),
    v = el.value;
  el.innerHTML = `<option value="">${first}</option>` + opts.map(o => `<option>${esc(o)}</option>`).join('');
  el.value = opts.includes(v) ? v : '';
}
let pView = 'pastas';
const openF = {};
function renderPipes() {
  fillSelect('#pGroup', 'Todas as pastas', groups());
  const q = $('#pSearch').value.toLowerCase(),
    g = $('#pGroup').value,
    st = $('#pStatus').value,
    tc = $('#pTech').value;
  const rows = PIPES.map(p => ({ p, last: RUNS.find(r => r.p === p.name) })).filter(
    ({ p, last }) =>
      p.name.toLowerCase().includes(q) &&
      (!g || p.group === g) &&
      (!tc || p.tech === tc) &&
      (!st || (last && last.s === st))
  );
  const cells = ({ p, last }) =>
    `<td>${techBadge(p.tech)}${p.active === false ? ' <span class="pill off sm">Inativo</span>' : ''}</td><td>${last ? (last.s === 'Executando' ? 'agora' : fmtDate(last.at)) : '—'}</td><td>${last ? pill(last.s) : '<span class="pill off">Sem execuções</span>'}</td><td>${pct(p.rate)}</td><td><button class="kebab" data-menu="${esc(p.name)}" aria-label="Ações de ${esc(p.name)}">${KEBAB}</button></td>`;
  const nameCell = p => `<td><div class="pl"><span class="pl-ico">${icoOf(p.name)}</span>${esc(p.name)}</div></td>`;
  const folders = [...new Set(rows.map(x => x.p.group))];
  $('#pipeSummary').innerHTML =
    `<div class="psum"><div><b>${rows.length}</b> componente${rows.length === 1 ? '' : 's'} em <b>${folders.length}</b> pasta${folders.length === 1 ? '' : 's'}</div><div class="chips">${TECHS.map(t => `<button type="button" class="chip ${tc === t ? 'on' : ''}" data-techf="${t}" aria-pressed="${tc === t}" title="Filtrar por ${t}">${techBadge(t, rows.filter(x => x.p.tech === t).length)}</button>`).join('')}</div></div>`;
  $$('#pView button').forEach(b => b.classList.toggle('on', b.dataset.pv === pView));
  $('#pipeFolders').hidden = pView !== 'pastas';
  $('#pipeList').hidden = pView === 'pastas';
  if (pView === 'lista') {
    $('#pipeRows').innerHTML =
      rows.map(x => `<tr>${nameCell(x.p)}<td>${esc(x.p.group)}</td>${cells(x)}</tr>`).join('') ||
      '<tr><td colspan="7" class="empty">Nenhuma pipeline encontrada.</td></tr>';
    return;
  }
  $('#pipeFolders').innerHTML =
    folders
      .map(gn => {
        const items = rows.filter(x => x.p.group === gn),
          open = openF[gn] !== false;
        const counts = TECHS.map(t => [t, items.filter(x => x.p.tech === t).length]).filter(c => c[1]);
        const fails = items.filter(x => x.last && x.last.s === 'Falha').length;
        const runs = RUNS.filter(r => items.some(x => x.p.name === r.p) && r.s !== 'Executando');
        const avg = runs.length ? Math.round(runs.reduce((a, r) => a + r.d, 0) / runs.length) : 0;
        const phrase = joinPt(
          counts.map(([t, n], i) => (i === 0 ? `${n} componente${n === 1 ? '' : 's'} de ${t}` : `${n} de ${t}`))
        );
        return `<div class="folder"><div class="f-row"><button type="button" class="f-head" data-folder="${esc(gn)}" aria-expanded="${open}">
      <svg class="f-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="#ebe8fd" stroke="#5b4bdb" stroke-width="1.6"/></svg>
      <span class="f-txt"><span class="f-name">${esc(gn)}</span><span class="f-desc">${phrase}</span></span>
      <span class="f-meta"><span>média ${fmtDur(avg)}</span><span class="${fails ? 'bad' : 'ok'}">${fails ? fails + ' com falha' : 'tudo passando'}</span></span></button><button type="button" class="kebab f-menu" data-foldermenu="${esc(gn)}" aria-label="Ações da pasta ${esc(gn)}">${KEBAB}</button></div>
      <div class="f-bar" aria-hidden="true">${counts.map(([t, n]) => `<span class="${techCls(t)}" style="flex:${n}"></span>`).join('')}</div>
      ${open ? `<div class="table-wrap f-body"><table><thead><tr><th>Componente</th><th>Tecnologia</th><th>Última execução</th><th>Status</th><th>Taxa de sucesso</th><th></th></tr></thead><tbody>${items.map(x => `<tr>${nameCell(x.p)}${cells(x)}</tr>`).join('')}</tbody></table></div>` : ''}</div>`;
      })
      .join('') || '<p class="empty">Nenhum componente encontrado.</p>';
}
$('#pTech').addEventListener('input', renderPipes);
$('#pView').addEventListener('click', e => {
  const b = e.target.closest('[data-pv]');
  if (b) {
    pView = b.dataset.pv;
    renderPipes();
  }
});
$('#pipeFolders').addEventListener('click', e => {
  const b = e.target.closest('[data-folder]');
  if (b) {
    const k = b.dataset.folder;
    openF[k] = openF[k] === false;
    renderPipes();
  }
});
$('#pipeSummary').addEventListener('click', e => {
  const b = e.target.closest('[data-techf]');
  if (b) {
    $('#pTech').value = $('#pTech').value === b.dataset.techf ? '' : b.dataset.techf;
    renderPipes();
  }
});
['#pSearch', '#pGroup', '#pStatus'].forEach(s => $(s).addEventListener('input', renderPipes));
