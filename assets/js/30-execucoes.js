// QA AI Agent · Execuções › Histórico e Importar JSON
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 3. Execuções ---------- */
let page = 1;
const PER = 10;
function renderExecs() {
  fillSelect(
    '#ePipe',
    'Todas as pipelines',
    PIPES.map(p => p.name)
  );
  const q = $('#eSearch').value.toLowerCase().replace('#', ''),
    pp = $('#ePipe').value,
    st = $('#eStatus').value,
    days = +$('#eDays').value;
  const [lim] = periodRange(days || 1);
  const list = RUNS.filter(
    r =>
      (String(r.id).includes(q) || r.p.toLowerCase().includes(q)) &&
      (!pp || r.p === pp) &&
      (!st || r.s === st) &&
      (!days || r.at >= lim)
  );
  const pages = Math.max(1, Math.ceil(list.length / PER));
  page = Math.min(page, pages);
  $('#execRows').innerHTML =
    list
      .slice((page - 1) * PER, page * PER)
      .map(
        r =>
          `<tr class="click" data-go="exec-${r.id}"><td><a href="#exec-${r.id}">#${r.id}</a></td><td>${esc(r.p)}</td><td>${pill(r.s)}</td><td>${r.ok} / ${r.t}</td><td>${r.s === 'Executando' ? '—' : fmtDur(r.d)}</td><td>${r.s === 'Executando' ? 'agora' : fmtDate(r.at)}</td></tr>`
      )
      .join('') || '<tr><td colspan="6" class="empty">Nenhuma execução encontrada.</td></tr>';
  let pg = `<button data-page="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Página anterior">‹</button>`;
  const want = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter(i => i >= 1 && i <= pages)
    .sort((a, b) => a - b);
  let prev = 0;
  want.forEach(i => {
    if (i - prev > 1) pg += '<span class="gap">…</span>';
    pg += `<button data-page="${i}" class="${i === page ? 'on' : ''}">${i}</button>`;
    prev = i;
  });
  $('#pager').innerHTML =
    pg + `<button data-page="${page + 1}" ${page === pages ? 'disabled' : ''} aria-label="Próxima página">›</button>`;
}
['#eSearch', '#ePipe', '#eStatus', '#eDays'].forEach(s =>
  $(s).addEventListener('input', () => {
    page = 1;
    renderExecs();
  })
);
$('#pager').addEventListener('click', e => {
  const b = e.target.closest('[data-page]');
  if (b && !b.disabled) {
    page = +b.dataset.page;
    renderExecs();
  }
});
$('#importJson').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const arr = Array.isArray(data) ? data : data.executions || data.execucoes || [data];
    let n = 0;
    arr.forEach(x => {
      const p = x.pipeline || x.p;
      if (!p) return;
      const t = +(x.total ?? x.cenarios ?? x.t ?? 1),
        ok = +(x.passed ?? x.sucessos ?? x.ok ?? t);
      if (!PIPES.find(q => q.name === p))
        PIPES.push({
          name: p,
          group: x.grupo || x.group || 'Importado',
          ico: 'box',
          rate: 100,
          dur: +(x.duration ?? x.duracao ?? 60),
          scen: t,
          tech: /mob/i.test(x.tecnologia || x.tech || '') ? 'Mobile' : 'API',
        });
      RUNS.unshift({
        id: RUNS[0].id + 1,
        p,
        s: ok === t ? 'Sucesso' : 'Falha',
        ok,
        t,
        d: +(x.duration ?? x.duracao ?? 60),
        at: x.inicio || x.start ? new Date(x.inicio || x.start) : new Date(BASE),
      });
      n++;
    });
    toast(
      n
        ? `${n} execução(ões) importada(s)`
        : 'Nenhuma execução válida no arquivo. Use campos "pipeline", "total" e "passed".'
    );
    saveData();
    renderExecs();
  } catch (err) {
    toast('Arquivo inválido: envie um JSON com uma lista de execuções.');
  }
  e.target.value = '';
});
