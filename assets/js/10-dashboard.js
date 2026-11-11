// QA AI Agent · Tela Dashboard
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 1. Dashboard ---------- */
let period = '7';
function runRow(r) {
  return `<tr><td><div class="pl"><span class="pl-ico">${icoOf(r.p)}</span>${esc(r.p)}</div></td><td>${esc(grpOf(r.p))}</td>
  <td>${pill(r.s)}</td><td>${r.ok} / ${r.t}</td><td>${r.s === 'Executando' ? '—' : fmtDur(r.d)}</td><td>${r.s === 'Executando' ? 'agora' : fmtDate(r.at)}</td>
  <td><button class="btn-out" data-go="exec-${r.id}">Ver detalhes</button></td></tr>`;
}
const pill = s =>
  `<span class="pill ${s === 'Falha' ? 'fail' : s === 'Executando' ? 'run' : ['Inativo', 'Pendente', 'Cancelada'].includes(s) ? 'off' : 'pass'}">${s === 'Executando' ? '<span class="live-dot"></span> ' : ''}${s}</span>`;
function dashData() {
  const runs = runsIn(7),
    prev = runsIn(7, 1),
    n = runs.length,
    ok = runs.filter(r => r.s === 'Sucesso').length,
    fail = n - ok;
  const avg = n ? runs.reduce((a, r) => a + r.d, 0) / n : 0,
    pavg = prev.length ? prev.reduce((a, r) => a + r.d, 0) / prev.length : null;
  const byP = {};
  runs.filter(r => r.s === 'Falha').forEach(r => (byP[r.p] = (byP[r.p] || 0) + 1));
  const top = Object.entries(byP).sort((a, b) => b[1] - a[1]),
    main = top.slice(0, 3),
    rest = top.slice(3).reduce((a, x) => a + x[1], 0);
  const names = main.map(x => x[0]).concat(rest ? ['Outros'] : []),
    counts = main.map(x => x[1]).concat(rest ? [rest] : []);
  const split = counts.map(c => (fail ? Math.round((c / fail) * 100) : 0));
  const bs = buckets(runs, 7);
  let last = 100;
  const vals = bs.map(b => (b.rate === null ? last : (last = Math.max(80, +b.rate.toFixed(1)))));
  return {
    exec: n.toLocaleString('pt-BR'),
    execDh: deltaHtml(n, prev.length || null, '%', false),
    succ: ok.toLocaleString('pt-BR'),
    rate: (n ? (ok / n) * 100 : 0).toFixed(1).replace('.', ','),
    fail: fail.toLocaleString('pt-BR'),
    failR: (n ? (fail / n) * 100 : 0).toFixed(1).replace('.', ','),
    dur: fmtDur(Math.round(avg)),
    durDh: deltaHtml(avg, pavg, '%', true),
    labels: bs.map(b => b.label),
    vals,
    names,
    counts,
    split,
  };
}
function renderDashboard() {
  const P = dashData();
  $('#kpis').innerHTML = `
  <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="M10 8.3v7.4l5.8-3.7z"/>', 28, '#2a2b3f', 1.6)}Execuções</div><div class="kpi-v">${P.exec}</div><div class="kpi-s">${P.execDh}</div></div>
  <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/>', 28, '#16a34a')}Sucessos</div><div class="kpi-v">${P.succ}</div><div class="kpi-s ok">${P.rate}% de sucesso</div></div>
  <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="m8.5 8.5 7 7m0-7-7 7"/>', 28, '#dc2626')}Falhas</div><div class="kpi-v">${P.fail}</div><div class="kpi-s bad">${P.failR}% de falhas</div></div>
  <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="13.5" r="8"/><path d="M12 9.5v4.2l2.6 1.6M9.5 2.5h5M12 2.5v3M19 6l1.3-1.3"/>', 28, '#2a2b3f', 1.7)}Duração média<span class="kpi-tag">por plataforma</span></div>${durByTech()}<div class="kt-foot" title="Média de todas as execuções do período, sem separar plataforma">Geral do período <b>${P.dur}</b><span>${P.durDh}</span></div></div>`;
  drawLine('#lineChart', P.labels, P.vals);
  const cols = ['#6d5ef0', '#3b82f6', '#f59e0b', '#22c55e'],
    names = P.names,
    counts = P.counts;
  const R = 68,
    C = 2 * Math.PI * R,
    GAP = 3,
    cx = 84;
  let off = 0,
    s = '';
  P.split.forEach((v, i) => {
    const len = Math.max(0, (v / 100) * C - GAP);
    s += `<circle class="seg" data-i="${i}" cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="${cols[i]}" stroke-width="18" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cx})"><title>${esc(names[i])}: ${counts[i]} falhas (${v}%)</title></circle>`;
    off += (v / 100) * C;
  });
  s += `<text x="${cx}" y="${cx + 4}" text-anchor="middle" font-size="34" font-weight="700" fill="#14142b" style="font-variant-numeric:tabular-nums">${P.fail}</text><text x="${cx}" y="${cx + 26}" text-anchor="middle" font-size="14" fill="#55576b">falhas</text>`;
  $('#donut').innerHTML = s;
  const mx = Math.max(1, ...P.split);
  $('#legend').innerHTML = P.split
    .map(
      (v, i) =>
        `<li><button data-ask="${esc(names[i])}" data-i="${i}" title="${esc(CFG.ai ? `Analisar ${names[i]} com a IA` : `${names[i]}: ${counts[i]} falhas`)}"><span class="dot" style="background:${cols[i]}"></span><span class="nm">${esc(names[i])}</span><span class="ct">${counts[i]}</span><span class="pct">${v}%</span><span class="lg-bar"><i style="width:${(v / mx) * 100}%;background:${cols[i]}"></i></span></button></li>`
    )
    .join('');
  $('#fpTotal').textContent = `${P.failR}% das execuções`;
  $('#fpNote').innerHTML = names.length
    ? `<b>${esc(names[0])}</b> concentra ${P.split[0]}% das falhas (${counts[0]} de ${P.fail}).`
    : 'Nenhuma falha nos últimos 7 dias.';
  $('.fp-foot [data-ask]')?.setAttribute('data-ask', names[0] || 'Checkout');
  $('#lastRuns').innerHTML = RUNS.filter(r => r.s !== 'Executando')
    .slice(0, 4)
    .map(runRow)
    .join('');
}
function durByTech() {
  // Média própria de cada plataforma: soma das durações das execuções concluídas dela ÷ nº de execuções dela (no período do filtro)
  const [lim] = periodRange(+period);
  const rows = TECHS.map(t => {
    const names = PIPES.filter(p => p.tech === t).map(p => p.name);
    const runs = RUNS.filter(r => names.includes(r.p) && (r.s === 'Sucesso' || r.s === 'Falha') && r.at >= lim);
    const sum = runs.reduce((a, r) => a + r.d, 0);
    return { t, n: runs.length, sum, v: runs.length ? Math.round(sum / runs.length) : 0 };
  }).filter(r => r.n);
  const mx = Math.max(1, ...rows.map(r => r.v));
  return `<div class="kpi-tech" aria-label="Duração média por plataforma">${rows.map(r => `<div class="kt-r" title="${r.t}: ${Math.round(r.sum).toLocaleString('pt-BR')}s ÷ ${r.n} execuções = ${fmtDur(r.v)}"><span class="kt-l t-${techCls(r.t)}">${svg(TECH_IC[r.t], 14, 'currentColor', 2.2)}${r.t}</span><b class="kt-v">${fmtDur(r.v)}</b><span class="kt-bar"><i class="t-${techCls(r.t)}" style="width:${(r.v / mx) * 100}%"></i></span><span class="kt-n">${r.n} exec.</span></div>`).join('') || '<p class="kt-n">Sem execuções no período.</p>'}</div>`;
}
function drawLine(sel, labels, vals) {
  const l = 46,
    r = 460,
    t = 16,
    b = 190,
    min = 80,
    max = 100,
    x = i => l + 20 + i * ((r - l - 30) / Math.max(1, vals.length - 1)),
    y = v => b - ((v - min) / (max - min)) * (b - t);
  let g =
    '<defs><linearGradient id="lg' +
    sel.slice(1) +
    '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7b6ff5" stop-opacity=".35"/><stop offset="1" stop-color="#7b6ff5" stop-opacity=".06"/></linearGradient></defs>';
  [100, 95, 90, 85, 80].forEach(v => {
    g += `<line x1="${l}" x2="${r}" y1="${y(v)}" y2="${y(v)}" stroke="#e8e9f0"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12.5" fill="#33344a">${v}%</text>`;
  });
  const pts = vals.map((v, i) => [x(i), y(v)]),
    line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  g += `<path d="${line} L${pts.at(-1)[0]},${b} L${pts[0][0]},${b} Z" fill="url(#lg${sel.slice(1)})"/><path d="${line}" fill="none" stroke="#5b4bdb" stroke-width="2.2" stroke-linejoin="round"/>`;
  pts.forEach((p, i) => {
    g += `<circle cx="${p[0]}" cy="${p[1]}" r="4.5" fill="#5b4bdb"><title>${labels[i]}: ${String(vals[i]).replace('.', ',')}%</title></circle><text x="${p[0]}" y="${b + 24}" text-anchor="middle" font-size="12.5" fill="#33344a">${labels[i]}</text>`;
  });
  $(sel).innerHTML = g;
}
$('#legend').addEventListener('mouseover', e => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  const d = $('#donut');
  d.classList.add('hl');
  d.querySelectorAll('.seg').forEach(c => c.classList.toggle('on', c.dataset.i === b.dataset.i));
});
$('#legend').addEventListener('mouseleave', () => $('#donut').classList.remove('hl'));
