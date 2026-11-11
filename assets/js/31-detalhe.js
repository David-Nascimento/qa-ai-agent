// QA AI Agent · Detalhe da execução
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 4. Detalhe ---------- */
let detTab = 'cen';
function renderDetail(id) {
  const r = RUNS.find(x => x.id === +id);
  if (!r) {
    $('#v-detalhe').innerHTML =
      '<p class="empty">Execução não encontrada. <a href="#execucoes">Voltar para Execuções</a></p>';
    return;
  }
  const liveNow = r.live && r.s === 'Executando';
  const sc = r.live
      ? r.live.sc.map(x => ({ n: x.n, d: Math.round(x.dur), f: x.st === 'fail', st: x.st }))
      : suiteFor(r),
    fails = sc.filter(x => x.f);
  const doneN = sc.filter(x => !x.st || x.st === 'pass' || x.st === 'fail').length,
    rate = liveNow ? (doneN ? (r.ok / doneN) * 100 : 0) : r.t ? (r.ok / r.t) * 100 : 0;
  const tab =
    detTab === 'cen'
      ? `<div class="table-wrap"><table><thead><tr><th>Cenário</th><th>Status</th><th>Duração</th></tr></thead><tbody>${sc.map(x => `<tr><td>${esc(x.n)}</td><td>${pill(x.st === 'run' ? 'Executando' : x.st === 'pend' ? 'Pendente' : x.st === 'skip' ? 'Cancelada' : x.f ? 'Falha' : 'Sucesso')}</td><td>${x.st === 'pend' || x.st === 'skip' ? '—' : fmtDur(x.d).replace(/^0m /, '')}</td></tr>`).join('')}</tbody></table></div>`
      : detTab === 'logs'
        ? `<div class="log">${logFor(
            r,
            sc.filter(x => !x.st || x.st === 'pass' || x.st === 'fail')
          )}</div>`
        : `<div class="evid">${fails.length ? fails.map(x => `<figure><svg class="shot" viewBox="0 0 320 200" role="img" aria-label="Captura de tela de ${esc(x.n)}"><rect width="320" height="200" fill="#f6f7fa"/><rect x="0" y="0" width="320" height="22" fill="#e7e8ef"/><circle cx="12" cy="11" r="4" fill="#ef4444"/><circle cx="24" cy="11" r="4" fill="#f59e0b"/><circle cx="36" cy="11" r="4" fill="#22c55e"/><rect x="20" y="40" width="180" height="12" rx="4" fill="#d9dbe5"/><rect x="20" y="62" width="280" height="60" rx="8" fill="#fff" stroke="#e7e8ef"/><rect x="20" y="136" width="280" height="40" rx="8" fill="#fde2e2"/><text x="34" y="161" font-size="13" fill="#c81e1e" font-family="Inter,sans-serif">Erro ao processar pagamento</text></svg><figcaption><span>${esc(x.n.split(' - ')[0])}.png</span><span style="color:var(--muted)">${fmtDate(r.at).split(', ')[1]}</span></figcaption></figure>`).join('') : '<p class="empty">Nenhuma evidência: todos os cenários passaram.</p>'}</div>`;
  $('#v-detalhe').innerHTML = `
   <div class="crumb"><a href="#execucoes">Execuções</a><span>›</span><span>#${runNo(r)}</span></div>
   <div class="det-h"><div><h1>Execução #${runNo(r)} ${pill(r.s)}</h1><div class="meta">Pipeline: <b>${esc(r.p)}</b> &nbsp;&nbsp;|&nbsp;&nbsp; Grupo: <b>${esc(grpOf(r.p))}</b> &nbsp;&nbsp;|&nbsp;&nbsp; ${techBadge(techOf(r.p))}</div></div>
     <div class="right"><span>${r.s === 'Executando' ? 'agora' : fmtDate(r.at)}</span><span>Duração: ${r.s === 'Executando' ? '—' : fmtDur(r.d)}</span></div></div>
   <div class="kpis k4" style="margin-bottom:22px">
     <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="M10 8.3v7.4l5.8-3.7z"/>', 24, '#2a2b3f', 1.6)}Cenários</div><div class="kpi-v">${r.t}</div></div>
     <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/>', 24, '#16a34a')}Sucessos</div><div class="kpi-v">${r.ok}</div></div>
     <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="m8.5 8.5 7 7m0-7-7 7"/>', 24, '#dc2626')}Falhas</div><div class="kpi-v">${fails.length}</div></div>
     <div class="card kpi"><div class="kpi-h">${svg('<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3"/>', 24, '#16a34a')}Taxa de sucesso</div><div class="kpi-v">${pct(rate)}</div></div>
   </div>
   <div class="card card-pad">
     <div class="tabs" id="dTabs"><button data-dt="cen" class="${detTab === 'cen' ? 'on' : ''}">Cenários (${r.t})</button><button data-dt="logs" class="${detTab === 'logs' ? 'on' : ''}">Logs</button><button data-dt="evid" class="${detTab === 'evid' ? 'on' : ''}">Evidências</button></div>
     ${tab}
     <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">${fails.length ? `<button class="btn-pri" data-ask-run="${r.id}">${svg(I.spark, 18, '#fff', 1.6)} Analisar falhas com IA</button>` : ''}<button class="btn-out" data-runpipe="${esc(r.p)}">Reexecutar pipeline</button></div>
   </div>`;
}
function logFor(r, sc) {
  const h = fmtDate(r.at).split(', ')[1];
  let out = `<span class="o">[${h}:00] INFO</span> Iniciando pipeline ${esc(r.p)} (#${runNo(r)}) — ${r.t} cenários\n`;
  sc.forEach((x, i) => {
    const ts = `[${h}:${String((i * 7 + 5) % 60).padStart(2, '0')}]`;
    if (!x.f) out += `<span class="o">${ts} PASS</span> ${esc(x.n)} (${x.d}s)\n`;
    else if (/Timeout/.test(x.n))
      out += `<span class="w">${ts} WARN</span> POST /api/payments/authorize sem resposta\n<span class="e">${ts} FAIL</span> ${esc(x.n)} — Timeout após 30000ms\n`;
    else if (/Confirmar/.test(x.n))
      out += `<span class="e">${ts} FAIL</span> ${esc(x.n)} — GET /checkout/confirm retornou 500 Internal Server Error\n`;
    else out += `<span class="e">${ts} FAIL</span> ${esc(x.n)} — AssertionError: esperado status 200, recebido 422\n`;
  });
  return out + `<span class="${r.ok === r.t ? 'o' : 'e'}">[fim]</span> ${r.ok}/${r.t} cenários passaram`;
}
$('#v-detalhe').addEventListener('click', e => {
  const t = e.target.closest('[data-dt]');
  if (t) {
    detTab = t.dataset.dt;
    renderDetail(location.hash.split('-')[1]);
  }
});
