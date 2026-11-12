// QA AI Agent · Execuções › Ao vivo: simulação e cards
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- Motor de tempo real (simulação) ---------- */
const SPEED = 10,
  T0 = Date.now(),
  LIVE = [],
  EVENTS = [];
let lvAuto = true,
  tk = 0;
// Modo conectado: index.html?api=http://localhost:3000&key=SEU_API_KEY
// A chave só serve para a primeira abertura: é guardada na sessão da aba (some ao fechar) e removida da URL,
// para não ficar no histórico, em favoritos, no Referer nem em capturas de tela.
const QS = new URLSearchParams(location.search),
  API = (QS.get('api') || '').replace(/\/$/, ''),
  API_KEY = (() => {
    let k = QS.get('key') || '';
    try {
      if (k) sessionStorage.setItem('qa.key', k);
      else k = sessionStorage.getItem('qa.key') || '';
    } catch {
      /* sem sessionStorage: a chave vale só até recarregar */
    }
    if (QS.has('key')) {
      QS.delete('key');
      const q = QS.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
    return k;
  })();
const pipeOf = n => PIPES.find(p => p.name === n);
const simNow = () => (API ? new Date() : new Date(BASE.getTime() + 60000 + (Date.now() - T0) * SPEED));
const hms = d => d.toTimeString().slice(0, 8);
function respFor(p, fail) {
  const b = { API: 180, Mobile: 620, Web: 410 }[p.tech] || 250;
  return Math.round(b * (0.6 + Math.random() * 0.9) * (fail ? 2.5 : 1));
}
function logEvent(r, type, txt) {
  EVENTS.unshift({ at: simNow(), type, p: r.p, txt });
  if (EVENTS.length > 60) EVENTS.pop();
}
function startRun(name) {
  if (API) return triggerJenkins(name);
  startLive(name, true);
}
async function triggerJenkins(job) {
  const pp = pipeOf(job);
  if (pp && pp.job) job = pp.job;
  try {
    const r = await fetch(API + '/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
      body: JSON.stringify({ job }),
    });
    const d = await r.json().catch(() => ({}));
    const via = (pp && pp.src) || 'Jenkins';
    toast(r.ok ? `Execução de ${job} solicitada ao ${via}` : `${via} recusou a execução: ${d.error || r.status}`);
  } catch (e) {
    toast('Sem conexão com o servidor de tempo real.');
  }
}
function startLive(name, manual) {
  const p = pipeOf(name);
  if (!p) return null;
  if (LIVE.some(r => r.p === name && r.s === 'Executando')) {
    if (manual) toast(`${name} já está em execução`);
    return null;
  }
  const base = suiteFor({ p: name, t: p.scen, ok: p.scen }),
    sum = base.reduce((a, x) => a + x.d, 0) || 1,
    k = p.dur / sum;
  const sc = base.map(x => ({
    n: x.n,
    plan: Math.max(/Timeout/.test(x.n) ? 30 : 3, Math.round(x.d * k * (0.8 + Math.random() * 0.5))),
    dur: 0,
    st: 'pend',
    resp: null,
    pref: x.pref,
  }));
  const r = {
    id: Math.max(...RUNS.map(x => x.id)) + 1,
    p: name,
    s: 'Executando',
    ok: 0,
    t: sc.length,
    d: 0,
    at: simNow(),
    live: { sc, i: 0, el: 0, manual },
  };
  RUNS.unshift(r);
  LIVE.unshift(r);
  logEvent(r, 'start', `#${runNo(r)} iniciada · ${sc.length} cenários`);
  if (manual) {
    toast(`#${r.id} ${name} iniciada — acompanhe em Execuções › Ao vivo`);
    liveRefresh(true, true);
  }
  return r;
}
function advance(r, secs, quiet) {
  const lv = r.live;
  let changed = false;
  while (secs > 0 && lv.i < lv.sc.length && r.s === 'Executando') {
    const c = lv.sc[lv.i];
    c.st = 'run';
    const step = Math.min(c.plan - c.dur, secs);
    c.dur += step;
    lv.el += step;
    secs -= step;
    if (c.dur >= c.plan) {
      const p = pipeOf(r.p) || { rate: 95, tech: 'API' };
      const fail = c.pref ? Math.random() < 0.55 : Math.random() < ((100 - p.rate) / 100) * 0.6;
      c.st = fail ? 'fail' : 'pass';
      c.resp = fail && /Timeout/.test(c.n) ? 30000 : respFor(p, fail);
      if (!fail) r.ok++;
      const id = c.n.split(' - ')[0];
      logEvent(
        r,
        fail ? 'fail' : 'pass',
        fail
          ? `${id} falhou${c.resp >= 30000 ? ' (timeout 30000 ms)' : ` · ${c.resp} ms`}`
          : `${id} passou · ${c.resp} ms`
      );
      lv.i++;
      changed = true;
    }
  }
  r.d = Math.round(lv.el);
  if (lv.i >= lv.sc.length && r.s === 'Executando') {
    r.s = r.ok === r.t ? 'Sucesso' : 'Falha';
    logEvent(r, 'end', `#${runNo(r)} finalizada: ${r.s} (${r.ok}/${r.t}) em ${fmtDur(r.d)}`);
    if (lv.manual && !quiet) toast(`#${r.id} ${r.p}: ${r.s} (${r.ok}/${r.t})`);
  }
  return changed;
}
function curView() {
  const h = location.hash.slice(1) || 'dashboard';
  return h.startsWith('exec-') ? 'detalhe' : h;
}
function liveRefresh(changed, ended) {
  const v = curView();
  if (v === 'aovivo') renderLive();
  if (v === 'analises' && aTab === 'tempo' && $('#tempoRoot') && !$('#techFilter').open) updateTempo();
  if (changed) {
    if (v === 'execucoes') renderExecs();
    if (v === 'detalhe') {
      const id = +location.hash.split('-')[1],
        r = RUNS.find(x => x.id === id);
      if (r && r.live && (r.s === 'Executando' || ended)) renderDetail(id);
    }
  }
  if (ended) {
    if (v === 'dashboard') renderDashboard();
    if (v === 'pipelines') renderPipes();
    if (v === 'analises' && aTab !== 'tempo') renderAnalises();
  }
  const n = LIVE.filter(r => r.s === 'Executando').length,
    lc = $('#liveCount');
  lc.hidden = !n;
  lc.textContent = n;
  $$('[data-livecount]').forEach(x => {
    x.hidden = !n;
    x.textContent = n;
  });
}
function fillLivePipe() {
  const el = $('#lvPipe'),
    v = el.value;
  el.innerHTML = PIPES.map(p => `<option>${esc(p.name)}</option>`).join('');
  if (PIPES.some(p => p.name === v)) el.value = v;
}
const SC_IC = {
  pass: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  fail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.6" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  run: '<span class="spin"></span>',
  pend: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b8bac8" stroke-width="2"><circle cx="12" cy="12" r="7"/></svg>',
  skip: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b8bac8" stroke-width="2.4" stroke-linecap="round"><path d="M7 12h10"/></svg>',
};
function cardFor(r) {
  let el = document.getElementById('lc-' + r.id);
  if (el) return el;
  const p = pipeOf(r.p) || { group: '—', tech: 'API' };
  el = document.createElement('article');
  el.className = 'card lcard';
  el.id = 'lc-' + r.id;
  el.innerHTML = `<header class="lc-h"><span class="pl-ico">${icoOf(r.p)}</span><div class="lc-id"><b title="${esc(r.p)}">${esc(r.p)}</b><small>${esc(p.group)} · #${runNo(r)} ${techBadge(p.tech)}</small></div><span class="lc-status"></span></header>
    <div class="lc-time"></div><div class="lc-prog" aria-hidden="true"></div><div class="lc-stats"></div><ol class="lc-scen"></ol>
    <footer class="lc-f"><button type="button" class="btn-out" data-go="exec-${r.id}">Ver detalhes</button><button type="button" class="btn-out" data-stop="${r.id}">Parar</button></footer>`;
  return el;
}
function updateCard(r, el) {
  const p = pipeOf(r.p) || { dur: r.d || 1 },
    sc = r.live.sc,
    done = sc.filter(c => c.st === 'pass' || c.st === 'fail'),
    f = done.filter(c => c.st === 'fail').length;
  const rs = done.filter(c => c.resp && c.resp < 30000),
    resp = rs.length ? Math.round(rs.reduce((a, c) => a + c.resp, 0) / rs.length) : 0,
    running = r.s === 'Executando';
  const el2 = Math.round(r.live.el),
    delta = p.dur ? Math.round(((running && done.length ? (el2 / done.length) * r.t : el2) / p.dur - 1) * 100) : 0;
  el.querySelector('.lc-status').innerHTML = pill(r.s);
  el.querySelector('.lc-time').innerHTML =
    `<div class="lc-clock"><b>${fmtDur(el2)}</b>${running ? 'decorrido' : 'tempo total'}</div><div class="lc-meta">média ${fmtDur(p.dur)}${running ? (el2 < p.dur ? ` · restante ≈ ${fmtDur(p.dur - el2)}` : ' · acima da média') : ''}${done.length ? ` · <span class="delta ${delta > 0 ? 'up' : 'dn'}">${delta > 0 ? '+' : ''}${delta}% ${running ? '(projeção)' : ''}</span>` : ''}</div>`;
  el.querySelector('.lc-prog').innerHTML = sc.map(c => `<i class="${c.st}"></i>`).join('');
  el.querySelector('.lc-stats').innerHTML =
    `<span><b>${done.length}/${r.t}</b> cenários</span><span class="ok">✓ ${done.length - f}</span><span class="bad">✗ ${f}</span><span>resp. médio <b>${resp ? resp + ' ms' : '—'}</b></span>`;
  const list = el.querySelector('.lc-scen');
  list.innerHTML = sc
    .map(
      c =>
        `<li class="${c.st}"><span>${SC_IC[c.st]}</span><span class="n" title="${esc(c.n)}">${esc(c.n)}</span><span class="ms ${c.resp >= 1000 ? 'slow' : ''}">${c.resp ? c.resp + ' ms' : ''}</span><span class="ms">${c.st === 'pend' || c.st === 'skip' ? '—' : Math.round(c.dur) + 's'}</span></li>`
    )
    .join('');
  if (running) {
    const cur = list.querySelector('li.run');
    if (cur) list.scrollTop = Math.max(0, cur.offsetTop - 70);
  }
  if (!running && !el.dataset.final) {
    el.dataset.final = '1';
    el.querySelector('.lc-f').innerHTML =
      `<button type="button" class="btn-out" data-go="exec-${r.id}">Ver detalhes</button>${f ? `<button type="button" class="btn-out pri" data-ask-run="${r.id}">Analisar com IA</button>` : ''}<button type="button" class="btn-out" data-runpipe="${esc(r.p)}">Reexecutar</button>`;
  }
}
function renderLive() {
  const running = LIVE.filter(r => r.s === 'Executando'),
    done = LIVE.filter(r => r.s !== 'Executando').slice(0, 6),
    keep = new Set([...running, ...done].map(r => 'lc-' + r.id));
  $$('.lcard').forEach(c => {
    if (!keep.has(c.id)) c.remove();
  });
  [
    [running, '#lvRun'],
    [done, '#lvDone'],
  ].forEach(([arr, sel]) => {
    const box = $(sel);
    arr.forEach((r, i) => {
      const c = cardFor(r);
      if (box.children[i] !== c) box.insertBefore(c, box.children[i] || null);
      updateCard(r, c);
    });
  });
  $('#lvRunEmpty').hidden = !!running.length;
  $('#lvDoneEmpty').hidden = !!done.length;
  const all = LIVE.flatMap(r => r.live.sc),
    fin = all.filter(c => c.st === 'pass' || c.st === 'fail'),
    fl = fin.filter(c => c.st === 'fail'),
    rs = fin.filter(c => c.resp && c.resp < 30000),
    to = fin.filter(c => c.resp >= 30000).length;
  $('#lvKpis').innerHTML = `
   <div class="card kpi"><div class="kpi-h"><span class="live-dot"></span>Em execução</div><div class="kpi-v">${running.length}</div><div class="kpi-s">esteiras ativas agora</div></div>
   <div class="card kpi"><div class="kpi-h">Cenários concluídos</div><div class="kpi-v">${fin.length}</div><div class="kpi-s ok">${fin.length - fl.length} com sucesso</div></div>
   <div class="card kpi"><div class="kpi-h">Falhas ao vivo</div><div class="kpi-v">${fl.length}</div><div class="kpi-s bad">${to} por timeout</div></div>
   <div class="card kpi"><div class="kpi-h">Tempo médio de resposta</div><div class="kpi-v">${rs.length ? Math.round(rs.reduce((a, c) => a + c.resp, 0) / rs.length) : 0} <small>ms</small></div><div class="kpi-s">sem contar timeouts</div></div>`;
  const col = { start: '#5b4bdb', pass: '#22c55e', fail: '#ef4444', end: '#14142b', stop: '#9a9cb0' };
  $('#lvFeed').innerHTML =
    EVENTS.map(
      e =>
        `<li class="${e.type}"><time>${hms(e.at)}</time><span class="dt" style="background:${col[e.type]}"></span><span><b>${esc(e.p)}</b> ${esc(e.txt)}</span></li>`
    ).join('') || '<li class="empty">Os eventos aparecem aqui.</li>';
  if ($('#lvComp'))
    $('#lvComp').innerHTML = PIPES.map(p => {
      const live = LIVE.find(r => r.p === p.name && r.s === 'Executando'),
        last = live || RUNS.find(r => r.p === p.name && r.s !== 'Executando'),
        lv = live && live.live;
      const dn = lv ? lv.sc.filter(c => c.st === 'pass' || c.st === 'fail') : [],
        fc = lv ? dn.filter(c => c.st === 'fail').length : last ? last.t - last.ok : 0,
        okc = lv ? dn.length - fc : last ? last.ok : 0;
      const time = live ? (dn.length ? Math.round((lv.el / dn.length) * live.t) : 0) : last ? last.d : 0,
        delta = time && p.dur ? Math.round((time / p.dur - 1) * 100) : null;
      const rsp = LIVE.filter(r => r.p === p.name)
          .flatMap(r => r.live.sc)
          .filter(c => c.resp && c.resp < 30000),
        resp = rsp.length
          ? Math.round(rsp.reduce((a, c) => a + c.resp, 0) / rsp.length)
          : { API: 180, Mobile: 620, Web: 410 }[p.tech] || 250;
      return {
        live: !!live,
        h: `<tr class="${live ? 'is-live' : ''}"><td><div class="pl"><span class="pl-ico">${icoOf(p.name)}</span>${esc(p.name)}</div></td><td>${esc(p.group)}</td><td>${techBadge(p.tech)}</td>
     <td>${live ? `<span class="pill run"><span class="live-dot"></span> ${dn.length}/${live.t}</span>` : last ? pill(last.s) : '—'}</td>
     <td><b>${live ? fmtDur(Math.round(lv.el)) : last ? fmtDur(last.d) : '—'}</b>${live && dn.length ? `<small class="proj">projeção ${fmtDur(time)}</small>` : ''}</td><td>${fmtDur(p.dur)}</td>
     <td>${delta === null ? '—' : `<span class="delta ${delta > 0 ? 'up' : 'dn'}">${delta > 0 ? '+' : ''}${delta}%</span>`}</td><td>${resp} ms</td><td><span class="ok">${okc}</span> / <span class="bad">${fc}</span></td></tr>`,
      };
    })
      .sort((a, b) => b.live - a.live)
      .map(x => x.h)
      .join('');
}
$('#lvRunBtn').addEventListener('click', () => startRun($('#lvPipe').value));
$('#lvAuto').addEventListener('change', e => {
  lvAuto = e.target.checked;
  toast(lvAuto ? 'Simulação automática ligada' : 'Simulação automática pausada');
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-stop]');
  if (!b) return;
  const r = RUNS.find(x => x.id === +b.dataset.stop);
  if (!r || r.s !== 'Executando') return;
  if (r.live.ext && API) {
    fetch(API + '/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
      body: JSON.stringify({ job: (pipeOf(r.p) || {}).job || r.p, build: runNo(r) }),
    })
      .then(x =>
        toast(
          x.ok
            ? `Parada de #${runNo(r)} solicitada ao ${r.src || 'Jenkins'}`
            : `O ${r.src || 'Jenkins'} recusou a parada`
        )
      )
      .catch(() => toast('Sem conexão com o servidor de tempo real.'));
    return;
  }
  r.live.sc.forEach(c => {
    if (c.st === 'pend' || c.st === 'run') c.st = 'skip';
  });
  r.s = 'Cancelada';
  logEvent(r, 'stop', `#${r.id} interrompida pelo usuário`);
  toast(`#${r.id} ${r.p} interrompida`);
  liveRefresh(true, true);
});
// Esteiras já em andamento ao abrir a plataforma
