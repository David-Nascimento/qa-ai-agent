// QA AI Agent · Análises › Qualidade e Estabilidade (métricas por período)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 6. Análises ---------- */
let aTab = 'geral';
/* Métricas de Análises calculadas a partir das execuções do período escolhido */
const DAY = 864e5;
// "Hoje" da plataforma: com servidor conectado é a data real; sem servidor, a data fixa dos dados de exemplo (BASE)
const today = () => (API ? new Date() : BASE);
function periodRange(days, back = 0) {
  const t = today(),
    e0 = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1),
    end = new Date(e0 - back * days * DAY),
    start = new Date(end - days * DAY);
  return [start, end];
}
function runsIn(days, back = 0) {
  const [a, b] = periodRange(days, back);
  return RUNS.filter(r => (r.s === 'Sucesso' || r.s === 'Falha') && r.at >= a && r.at < b);
}
function failCause(n) {
  if (/Timeout/.test(n)) return 'Timeout de API';
  if (/Confirmar|500/.test(n)) return 'HTTP 500';
  let h = 0;
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ['Timeout de API', 'HTTP 500', 'Validação / dados', 'Validação / dados'][h % 4];
}
function scenarioStats(runs) {
  const m = new Map();
  runs.forEach(r =>
    suiteFor(r).forEach(x => {
      const k = r.p + '|' + x.n;
      const o = m.get(k) || { p: r.p, n: x.n, runs: 0, fails: 0 };
      o.runs++;
      if (x.f) o.fails++;
      m.set(k, o);
    })
  );
  return [...m.values()];
}
function mttr(runs) {
  // tempo médio entre uma execução com falha e a próxima execução com sucesso do mesmo componente
  const asc = [...runs].sort((a, b) => a.at - b.at),
    open = {},
    gaps = [];
  asc.forEach(r => {
    if (r.s === 'Falha') {
      if (!open[r.p]) open[r.p] = r.at;
    } else if (open[r.p]) {
      gaps.push((r.at - open[r.p]) / 1000);
      delete open[r.p];
    }
  });
  return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
}
function metrics(runs) {
  const ok = runs.filter(r => r.s === 'Sucesso').length,
    fail = runs.length - ok;
  const sc = scenarioStats(runs),
    flaky = sc.filter(x => x.fails > 0 && x.fails < x.runs);
  return { n: runs.length, ok, fail, rate: runs.length ? (ok / runs.length) * 100 : 0, flaky, sc, mttr: mttr(runs) };
}
const fmtLong = s => {
  s = Math.round(s);
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : fmtDur(s);
};
function buckets(runs, days) {
  // 7 e 30 dias: um ponto por dia · 90 dias: um ponto por semana
  const step = days > 30 ? 7 : 1,
    n = Math.ceil(days / step),
    [start, end] = periodRange(days),
    out = [];
  for (let i = 0; i < n; i++) {
    const b = new Date(end.getTime() - (n - 1 - i) * step * DAY),
      a = new Date(Math.max(start, b.getTime() - step * DAY));
    const rs = runs.filter(r => r.at >= a && r.at < b),
      ok = rs.filter(r => r.s === 'Sucesso').length;
    out.push({
      label: `${a.getDate()} ${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][a.getMonth()]}`,
      ok,
      ko: rs.length - ok,
      rate: rs.length ? (ok / rs.length) * 100 : null,
    });
  }
  return out;
}
function barChart(bs) {
  const l = 44,
    r = 640,
    t = 14,
    b = 210,
    mx = Math.max(4, ...bs.map(x => x.ok + x.ko)),
    u = mx > 200 ? 100 : mx > 80 ? 50 : mx > 20 ? 10 : 4,
    max = Math.ceil(mx / u) * u,
    y = v => b - (v / max) * (b - t),
    step = (r - l) / bs.length,
    bw = Math.max(4, Math.min(34, step * 0.6));
  const every = Math.ceil(bs.length / 8);
  let g = '';
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const v = Math.round(max * f);
    g += `<line x1="${l}" x2="${r}" y1="${y(v)}" y2="${y(v)}" stroke="#eceef3"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#55576b">${v}</text>`;
  });
  bs.forEach((x, i) => {
    const cx = l + step * i + (step - bw) / 2;
    g += `<rect x="${cx}" y="${y(x.ok + x.ko)}" width="${bw}" height="${y(x.ok) - y(x.ok + x.ko)}" fill="#ef4444"><title>${x.label}: ${x.ko} falhas</title></rect><rect x="${cx}" y="${y(x.ok)}" width="${bw}" height="${b - y(x.ok)}" fill="#22c55e"><title>${x.label}: ${x.ok} sucessos</title></rect>`;
    if (i % every === 0)
      g += `<text x="${cx + bw / 2}" y="${b + 22}" text-anchor="middle" font-size="12" fill="#55576b">${x.label}</text>`;
  });
  return g;
}
function lineChart(sel, bs) {
  const pts = bs.filter(x => x.rate !== null);
  if (!pts.length) {
    $(sel).innerHTML = '';
    return;
  }
  const lo = Math.max(0, Math.floor(Math.min(...pts.map(x => x.rate)) / 5) * 5 - 5);
  const l = 46,
    r = 460,
    t = 16,
    b = 190,
    x = i => l + 14 + i * ((r - l - 24) / Math.max(1, bs.length - 1)),
    y = v => b - ((v - lo) / (100 - lo)) * (b - t),
    every = Math.ceil(bs.length / 7);
  let g = `<defs><linearGradient id="lgA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7b6ff5" stop-opacity=".3"/><stop offset="1" stop-color="#7b6ff5" stop-opacity=".04"/></linearGradient></defs>`;
  for (let v = lo; v <= 100; v += Math.max(5, Math.round((100 - lo) / 4 / 5) * 5))
    g += `<line x1="${l}" x2="${r}" y1="${y(v)}" y2="${y(v)}" stroke="#eceef3"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#55576b">${v}%</text>`;
  const P = bs.map((d, i) => (d.rate === null ? null : [x(i), y(d.rate), d])).filter(Boolean),
    path = P.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  g += `<path d="${path} L${P.at(-1)[0]},${b} L${P[0][0]},${b} Z" fill="url(#lgA)"/><path d="${path}" fill="none" stroke="#5b4bdb" stroke-width="2.2" stroke-linejoin="round"/>`;
  P.forEach(p => {
    g += `<circle cx="${p[0]}" cy="${p[1]}" r="${bs.length > 14 ? 2.5 : 4}" fill="#5b4bdb"><title>${p[2].label}: ${pct(p[2].rate)}</title></circle>`;
  });
  bs.forEach((d, i) => {
    if (i % every === 0)
      g += `<text x="${x(i)}" y="${b + 24}" text-anchor="middle" font-size="12" fill="#55576b">${d.label}</text>`;
  });
  $(sel).innerHTML = g;
}
const deltaHtml = (cur, prev, unit, goodDown) => {
  if (prev === null || prev === undefined || !isFinite(prev)) return '<span class="muted">sem período anterior</span>';
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return '<span class="muted">igual ao período anterior</span>';
  const up = d > 0,
    good = goodDown ? !up : up;
  return `<span class="${good ? 'ok' : 'bad'}">${up ? '↑' : '↓'} ${unit === 'pp' ? Math.abs(d).toFixed(1).replace('.', ',') + ' p.p.' : unit === '%' ? Math.abs(Math.round(prev ? (d / prev) * 100 : 0)) + '%' : Math.abs(Math.round(d))}</span> vs. período anterior`;
};

function renderAnalises() {
  if (!['geral', 'tempo', 'estab'].includes(aTab)) aTab = 'geral';
  $$('#aTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === aTab));
  const days = +$('#aPeriod').value,
    label = $('#aPeriod').selectedOptions[0].textContent.toLowerCase();
  $('#aRange').textContent = (() => {
    const [a, b] = periodRange(days);
    return `${fmtDate(a).split(',')[0]} a ${fmtDate(new Date(b - 1)).split(',')[0]}`;
  })();
  if (aTab === 'tempo') return renderTempo();
  const runs = runsIn(days),
    M = metrics(runs),
    prevRuns = runsIn(days, 1),
    PM = prevRuns.length ? metrics(prevRuns) : null;
  if (aTab === 'geral') {
    const bs = buckets(runs, days);
    const fails = M.sc.reduce((a, x) => {
        if (x.fails) {
          const c = failCause(x.n);
          a[c] = (a[c] || 0) + x.fails;
        }
        return a;
      }, {}),
      ft = Object.values(fails).reduce((a, b) => a + b, 0) || 1;
    const causes = Object.entries(fails).sort((a, b) => b[1] - a[1]),
      cc = { 'Timeout de API': '#ef4444', 'HTTP 500': '#f59e0b', 'Validação / dados': '#6d5ef0' };
    const dnames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
      order = [1, 2, 3, 4, 5, 6, 0],
      hours = [...Array(15)].map((_, i) => i + 7);
    const heat = order.map(d =>
        hours.map(h => runs.filter(r => r.s === 'Falha' && r.at.getDay() === d && r.at.getHours() === h).length)
      ),
      hmax = Math.max(1, ...heat.flat());
    const cell = v => (v === 0 ? '#f1f2f6' : `rgba(220,38,38,${(0.2 + (0.8 * v) / hmax).toFixed(2)})`);
    let peak = [0, 0, 0];
    heat.forEach((row, di) =>
      row.forEach((v, hi) => {
        if (v > peak[0]) peak = [v, di, hi];
      })
    );
    $('#aBody').innerHTML = `<div class="kpis k4" style="margin-bottom:22px">
      <div class="card kpi"><div class="kpi-h">Execuções</div><div class="kpi-v">${M.n.toLocaleString('pt-BR')}</div><div class="kpi-s">${deltaHtml(M.n, PM ? PM.n : null, '%', false)}</div></div>
      <div class="card kpi"><div class="kpi-h">Taxa de sucesso</div><div class="kpi-v">${pct(M.rate)}</div><div class="kpi-s">${deltaHtml(M.rate, PM ? PM.rate : null, 'pp', false)}</div></div>
      <div class="card kpi"><div class="kpi-h">Execuções com falha</div><div class="kpi-v">${M.fail}</div><div class="kpi-s">${deltaHtml(M.fail, PM ? PM.fail : null, '%', true)}</div></div>
      <div class="card kpi"><div class="kpi-h">MTTR (médio)</div><div class="kpi-v">${M.mttr ? fmtLong(M.mttr) : '—'}</div><div class="kpi-s">${M.mttr && PM && PM.mttr ? deltaHtml(M.mttr, PM.mttr, '%', true) : 'da falha até a próxima execução com sucesso'}</div></div></div>
     ${
       M.n
         ? `<div class="an-sec"><h3>Sucessos e falhas ${days > 30 ? 'por semana' : 'por dia'}</h3><div class="chart-row"><svg class="chart" viewBox="0 0 650 240" role="img" aria-label="Sucessos e falhas no período">${barChart(bs)}</svg><div class="chart-legend"><span><i style="background:#22c55e"></i>Sucessos</span><span><i style="background:#ef4444"></i>Falhas</span></div></div></div>
     <div class="an-split">
       <div class="an-sec"><h3>Evolução da taxa de sucesso</h3><svg id="aLine" class="chart" viewBox="0 0 480 230" role="img" aria-label="Taxa de sucesso no período"></svg></div>
       <div class="an-sec"><h3>Falhas por causa raiz</h3>${causes.length ? `<div class="hbar">${causes.map(([c, v]) => `<div class="r"><span>${c}</span><div class="t"><span style="width:${(v / ft) * 100}%;background:${cc[c]}"></span></div><span class="v">${Math.round((v / ft) * 100)}%</span></div>`).join('')}</div><p class="an-note">${ft} cenários com falha no período, agrupados pela mensagem de erro do log.</p>` : '<p class="an-note">Nenhuma falha no período.</p>'}</div>
     </div>
     <div class="an-sec"><h3>Concentração de falhas por horário</h3>
       <div class="heat-wrap"><div class="heat" style="grid-template-columns:40px repeat(${hours.length},minmax(22px,1fr))"><span></span>${hours.map(h => `<span class="hl">${h}h</span>`).join('')}
       ${order.map((d, di) => `<span class="hl dl">${dnames[d]}</span>` + heat[di].map((v, hi) => `<i style="background:${cell(v)}" title="${dnames[d]} ${hours[hi]}h: ${v} execuç${v === 1 ? 'ão' : 'ões'} com falha"></i>`).join('')).join('')}</div></div>
       <p class="an-note">${peak[0] ? `Maior concentração: ${dnames[order[peak[1]]]} às ${hours[peak[2]]}h (${peak[0]} falha${peak[0] === 1 ? '' : 's'}).` : 'Nenhuma falha no período.'}</p></div>`
         : `<p class="empty">Nenhuma execução concluída ${label}.</p>`
     }`;
    if (M.n) lineChart('#aLine', bs);
  } else {
    const per = PIPES.map(p => {
      const rs = runs.filter(r => r.p === p.name),
        ok = rs.filter(r => r.s === 'Sucesso').length;
      return { n: p.name, runs: rs.length, f: rs.length - ok, rate: rs.length ? (ok / rs.length) * 100 : null };
    });
    const withF = per.filter(x => x.f).sort((a, b) => b.f - a.f),
      mx = Math.max(1, ...withF.map(x => x.f));
    const measured = per.filter(x => x.rate !== null),
      below = measured.filter(x => x.rate < CFG.goal).sort((a, b) => a.rate - b.rate);
    const fl = M.flaky
      .map(x => ({ ...x, r: (x.fails / x.runs) * 100 }))
      .sort((a, b) => b.r - a.r)
      .slice(0, 8);
    $('#aBody').innerHTML = `<div class="an-split" style="border-top:0">
      <div class="an-sec"><h3>Falhas por componente</h3>${withF.length ? `<div class="hbar">${withF.map(x => `<div class="r"><span>${esc(x.n)}</span><div class="t"><span style="width:${(x.f / mx) * 100}%;background:var(--red-2)"></span></div><span class="v" title="${x.f} de ${x.runs} execuções">${x.f}</span></div>`).join('')}</div>` : '<p class="an-note">Nenhuma falha no período.</p>'}${withF.length && withF.length < per.length ? `<p class="an-note">${per.length - withF.length} componentes sem falhas ${label}.</p>` : ''}</div>
      <div class="an-sec"><h3>Abaixo da meta de sucesso (${CFG.goal}%)</h3>${below.length ? `<div class="hbar">${below.map(p => `<div class="r"><span>${esc(p.n)}</span><div class="t"><span style="width:${Math.max(4, p.rate)}%;background:var(--orange)"></span></div><span class="v" title="${p.runs} execuções">${pct(p.rate)}</span></div>`).join('')}</div>` : '<p class="an-note">Todos os componentes estão na meta.</p>'}<p class="an-note">${measured.length - below.length} componentes na meta ou acima${per.length - measured.length ? ` · ${per.length - measured.length} sem execuções no período` : ''}. A meta é definida em Configurações.</p></div>
     </div>
     <div class="an-sec"><h3>Testes instáveis (flaky) <span class="muted" style="font-weight:500">· ${M.flaky.length} cenários que falharam e também passaram ${label}</span></h3>${
       fl.length
         ? `<div class="table-wrap"><table><thead><tr><th>Cenário</th><th>Componente</th><th>Falhas / execuções</th><th>Taxa de falha</th><th></th></tr></thead><tbody>${fl
             .map(x => {
               const id = (x.n.match(/CT-\d+/) || [''])[0];
               return `<tr><td>${id ? `<span class="key">${id}</span> ` : ''}<b style="color:var(--fg)">${esc(x.n.replace(/^CT-\d+\s*-\s*/, ''))}</b></td><td>${esc(x.p)}</td><td>${x.fails} / ${x.runs}</td><td><div class="mini"><span style="width:${Math.min(100, x.r)}%"></span></div>${pct(x.r)}</td><td><button class="link-btn ai-only" data-ask="${esc(x.p)}">Analisar com IA</button></td></tr>`;
             })
             .join('')}</tbody></table></div>`
         : '<p class="an-note">Nenhum teste instável no período.</p>'
     }</div>`;
  }
}
