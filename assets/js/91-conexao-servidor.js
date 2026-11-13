// QA AI Agent · Modo conectado (?api=): eventos SSE do servidor (Jenkins, GitHub Actions e Jira)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* Eventos reais vindos do servidor (Server-Sent Events) */
const extKey = {},
  extRun = d => extKey[d.job + '#' + d.build];
function extStart(d) {
  if (extRun(d)) return extRun(d);
  // job pode vir como caminho do Jenkins (Pasta/Job) ou do GitHub (dono/repo/workflow.yml):
  // o componente é o nome do workflow (d.name) ou, sem ele, a última parte do caminho
  const short = d.name || String(d.job).split('/').pop();
  const src = d.source || 'Jenkins';
  let p = pipeOf(d.job) || pipeOf(short);
  if (!p) {
    p = {
      name: short,
      group: d.folder || src,
      ico: 'box',
      rate: 100,
      dur: Math.round((d.estimatedDuration || 300000) / 1000),
      scen: d.total || 0,
      tech: d.tech || 'API',
    };
    PIPES.push(p);
  }
  p.job = d.job;
  p.src = src;
  const sc = (d.scenarios || []).map(n => ({ n, plan: 0, dur: 0, st: 'pend', resp: null }));
  const r = {
    id: uniqueRunId(+d.build),
    build: +d.build,
    p: p.name,
    s: 'Executando',
    ok: 0,
    t: d.total || sc.length,
    d: 0,
    at: new Date(d.timestamp || Date.now()),
    live: { sc, i: 0, el: 0, manual: false, ext: true },
  };
  RUNS.unshift(r);
  LIVE.unshift(r);
  extKey[d.job + '#' + d.build] = r;
  r.src = src;
  logEvent(r, 'start', `#${runNo(r)} iniciada no ${src}${d.branch ? ` (${d.branch})` : ''}`);
  return r;
}
function extScenario(d) {
  const r = extRun(d) || extStart(d),
    lv = r.live;
  let c = lv.sc.find(x => x.n === d.name);
  if (!c) {
    c = { n: d.name, plan: 0, dur: 0, st: 'pend', resp: null };
    lv.sc.push(c);
  }
  const before = c.st;
  c.st = d.status === 'fail' ? 'fail' : d.status === 'pass' ? 'pass' : 'run';
  c.dur = +(d.duration || 0);
  if (d.resp != null) c.resp = +d.resp;
  r.ok = lv.sc.filter(x => x.st === 'pass').length;
  r.t = Math.max(r.t, lv.sc.length);
  lv.el = d.elapsed != null ? +d.elapsed : lv.sc.reduce((a, x) => a + x.dur, 0);
  r.d = Math.round(lv.el);
  if (c.st !== 'run' && before !== c.st)
    logEvent(r, c.st, `${c.n} ${c.st === 'fail' ? 'falhou' : 'passou'}${c.resp ? ` · ${c.resp} ms` : ''}`);
}
function extEnd(d) {
  const r = extRun(d) || extStart(d);
  if (r.s !== 'Executando') return;
  r.live.sc.forEach(c => {
    if (c.st === 'run' || c.st === 'pend') c.st = 'skip';
  });
  if (d.total) r.t = d.total;
  if (d.passed != null) r.ok = d.passed;
  r.d = Math.round((d.duration || 0) / 1000) || r.d;
  r.live.el = r.d;
  r.s = d.status || (r.ok === r.t ? 'Sucesso' : 'Falha');
  logEvent(r, 'end', `#${runNo(r)} finalizada: ${r.s} (${r.ok}/${r.t}) em ${fmtDur(r.d)}`);
}
if (API) {
  lvAuto = false;
  $('#lvAuto').checked = false;
  $('#lvAuto').parentElement.hidden = true;
  $$('.ptabs [data-go="aovivo"]').forEach(b => {
    b.childNodes[1].textContent = 'Ao vivo · CI';
  });
  // Modo conectado usa só dados reais: os de exemplo saem, e o histórico gravado pelo servidor
  // (GET /api/history) é reconstruído pelo mesmo caminho dos eventos em tempo real.
  RUNS = [];
  fetch(API + '/api/history', { headers: API_KEY ? { 'x-api-key': API_KEY } : {} })
    .then(r => (r.ok ? r.json() : { runs: [] }))
    .then(({ runs = [] }) => {
      runs.forEach(h => {
        try {
          extStart(h.start);
          (h.scenarios || []).forEach(extScenario);
          extEnd(h.end);
        } catch (err) {
          console.error('histórico: registro ignorado', err);
        }
      });
      EVENTS.length = 0; // o que já terminou não entra no feed "Eventos"
      liveRefresh(true, true);
    })
    .catch(() => {});
  // status das integrações (conectada? origem? token salvo?) vem do servidor; o token nunca vem
  loadIntegrations();
  const authHeaders = API_KEY ? { 'x-api-key': API_KEY } : {};
  const bindEvents = es => {
    const on = (t, f) =>
      es.addEventListener(t, e => {
        try {
          f(JSON.parse(e.data));
          liveRefresh(true, t !== 'scenario');
        } catch (err) {
          console.error(err);
        }
      });
    on('build_start', extStart);
    on('scenario', extScenario);
    on('build_end', extEnd);
    on('stage', d => {
      const r = extRun(d);
      if (r) logEvent(r, 'pass', `Estágio "${d.stage}": ${d.status}`);
    });
    on('jira', d => {
      const r = extRun(d) || { p: d.job || 'Jira' };
      logEvent(
        r,
        'fail',
        `Bug ${d.key} ${d.action === 'comment' ? 'atualizado' : 'aberto'} no Jira para ${d.scenario}`
      );
    });
    // o servidor sincroniza o Jira sozinho e avisa; a tela só lê o cache (não chama o Jira)
    es.addEventListener('jira_sync', loadJiraState);
  };
  // O EventSource não envia cabeçalhos. Em vez de pôr a chave na URL, pedimos um tíquete de uso único
  // (POST /api/ticket com a chave no cabeçalho) e conectamos com ele. Como o tíquete vale uma conexão só,
  // a reconexão é nossa: fecha, espera (recuo progressivo) e pede um tíquete novo.
  let warned = false,
    wait = 1000,
    timer = null;
  const retry = () => {
    clearTimeout(timer);
    timer = setTimeout(connect, wait);
    wait = Math.min(wait * 2, 15000);
  };
  async function connect() {
    let url = API + '/events';
    try {
      const r = await fetch(API + '/api/ticket', { method: 'POST', headers: authHeaders });
      if (r.status === 401) return toast('Chave de API inválida: abra a plataforma com &key=… correta');
      if (r.ok) url += '?ticket=' + encodeURIComponent((await r.json()).ticket);
      else if (r.status === 404)
        url += API_KEY ? '?key=' + encodeURIComponent(API_KEY) : ''; // servidor antigo, sem tíquete
      else throw new Error('HTTP ' + r.status);
    } catch {
      if (!warned) {
        warned = true;
        toast('Sem conexão com o servidor de tempo real. Tentando novamente…');
      }
      return retry();
    }
    const es = new EventSource(url);
    bindEvents(es);
    es.onopen = () => {
      warned = false;
      wait = 1000;
      toast('Conectado ao servidor de tempo real');
    };
    es.onerror = () => {
      es.close();
      if (!warned) {
        warned = true;
        toast('Sem conexão com o servidor de tempo real. Tentando novamente…');
      }
      retry();
    };
  }
  connect();
  loadJiraState();
}
// Esteiras simuladas já em andamento ao abrir a plataforma (somente sem servidor)
if (!API)
  [
    ['Checkout', 380],
    ['App do Cliente', 160],
    ['Pagamento', 40],
  ].forEach(([n, s]) => {
    const r = startLive(n, false);
    if (r) {
      r.at = new Date(r.at - s * 1000);
      advance(r, s, true);
    }
  });
setInterval(() => {
  tk++;
  let changed = false,
    ended = false;
  LIVE.forEach(r => {
    if (r.live.ext && r.s === 'Executando') {
      r.live.el = Math.max(r.live.el, (Date.now() - r.at) / 1000);
      r.d = Math.round(r.live.el);
    }
  });
  LIVE.filter(r => r.s === 'Executando' && !r.live.ext).forEach(r => {
    if (advance(r, SPEED)) changed = true;
    if (r.s !== 'Executando') ended = true;
  });
  if (lvAuto && tk % 6 === 0 && LIVE.filter(r => r.s === 'Executando').length < 3) {
    const free = PIPES.filter(p => !LIVE.some(r => r.p === p.name && r.s === 'Executando'));
    if (free.length) {
      startLive(free[Math.floor(Math.random() * free.length)].name, false);
      changed = ended = true;
    }
  }
  liveRefresh(changed, ended);
}, 1000);
document.addEventListener('click', e => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-menu],[data-intmenu]')) $('#menu').hidden = true;
  const g = e.target.closest('[data-go]');
  if (g && !e.target.closest('a')) {
    go(g.dataset.go);
    return;
  }
  const rp = e.target.closest('[data-runpipe]');
  if (rp) startRun(rp.dataset.runpipe);
  const ak = CFG.ai && e.target.closest('[data-ask]');
  if (ak) askAgent(`Quais foram as principais falhas da pipeline de ${ak.dataset.ask} nesta semana?`);
  const ar = CFG.ai && e.target.closest('[data-ask-run]');
  if (ar) {
    const r = RUNS.find(x => x.id === +ar.dataset.askRun);
    go('agente');
    askAgent(`Por que a execução #${r.id} da pipeline de ${r.p} falhou?`);
  }
  const sg = CFG.ai && e.target.closest('[data-suggest]');
  if (sg) askAgent(sg.dataset.suggest);
  const tt = e.target.closest('[data-toast]');
  if (tt) toast(tt.dataset.toast);
  const ts = e.target.closest('[data-toggle-scen]');
  if (ts) {
    e.preventDefault();
    const s = SCENS.find(x => x.id === ts.dataset.toggleScen);
    s.s = s.s === 'Ativo' ? 'Inativo' : 'Ativo';
    saveData();
    renderScens();
    toast(`${s.id} ${s.s === 'Ativo' ? 'ativado' : 'desativado'}`);
  }
  const fm = e.target.closest('[data-foldermenu]');
  if (fm) {
    const g = fm.dataset.foldermenu;
    openMenu(fm, [
      {
        t: 'Executar todos os componentes',
        f: () => {
          const ps = PIPES.filter(p => p.group === g && p.active !== false);
          ps.forEach(p => startLive(p.name, false));
          toast(`${ps.length} componente(s) de ${g} em execução — acompanhe em Execuções › Ao vivo`);
          liveRefresh(true, true);
        },
      },
      {
        t: 'Ver tempo de execução',
        f: () => {
          AUF.proj = g;
          aTab = 'tempo';
          go('analises');
        },
      },
      { t: 'Renomear pasta', f: () => renameFolder(g) },
      { t: 'Excluir pasta', danger: true, f: () => deleteFolder(g) },
    ]);
  }
  const pm = e.target.closest('[data-menu]');
  if (pm) {
    const n = pm.dataset.menu;
    openMenu(pm, [
      { t: 'Executar agora', f: () => startRun(n) },
      {
        t: pipeOf(n)?.active === false ? 'Ativar componente' : 'Desativar componente',
        f: () => {
          const p = pipeOf(n);
          p.active = p.active === false;
          saveData();
          renderPipes();
          toast(`${n} ${p.active ? 'ativado' : 'desativado'}`);
        },
      },
      {
        t: 'Ver execuções',
        f: () => {
          go('execucoes');
          $('#ePipe').value = n;
          page = 1;
          renderExecs();
        },
      },
      ...(CFG.ai
        ? [
            {
              t: 'Analisar com IA',
              f: () => {
                go('agente');
                askAgent(`Quais foram as principais falhas da pipeline de ${n} nesta semana?`);
              },
            },
          ]
        : []),
      {
        t: 'Excluir pipeline',
        danger: true,
        f: () =>
          modal(
            'Excluir pipeline',
            `<p style="margin:0">Excluir a pipeline <b>${esc(n)}</b>? O histórico de execuções continua disponível.</p>`,
            () => {
              PIPES = PIPES.filter(p => p.name !== n);
              saveData();
              renderPipes();
              toast(`Pipeline ${n} excluída`);
            }
          ),
      },
    ]);
  }
  const im = e.target.closest('[data-intmenu]');
  if (im) openMenu(im, intMenuItems(INTS.find(x => x.k === im.dataset.intmenu)));
  const ci = e.target.closest('[data-int]');
  if (ci) configInt(INTS.find(x => x.k === ci.dataset.int));
  const op = e.target.closest('[data-open]');
  if (op && op.dataset.open === 'newPipe')
    modal(
      'Nova Pipeline',
      `<div class="field"><label for="np1">Nome</label><input id="np1" name="name" required></div>
     <div class="f2"><div class="field"><label for="np2">Pasta</label><input id="np2" name="group" list="grpList" required><datalist id="grpList">${groups()
       .map(g => `<option value="${esc(g)}">`)
       .join('')}</datalist></div>
     <div class="field"><label for="np3">Nº de cenários</label><input id="np3" name="scen" type="number" min="1" value="10" required></div></div>
     <div class="field"><label for="np4">Tecnologia</label><div class="sel"><select id="np4" name="tech">${opt(TECHS, 'API')}</select></div></div>`,
      fd => {
        const n = fd.get('name').trim();
        if (PIPES.find(p => p.name.toLowerCase() === n.toLowerCase())) {
          toast('Já existe uma pipeline com esse nome.');
          return false;
        }
        PIPES.push({
          name: n,
          group: fd.get('group').trim(),
          ico: 'box',
          rate: 100,
          dur: 300,
          scen: +fd.get('scen'),
          tech: fd.get('tech'),
        });
        saveData();
        renderPipes();
        toast(`Pipeline ${n} criada`);
      }
    );
  if (op && op.dataset.open === 'newScen')
    modal(
      'Novo Cenário',
      `<div class="field"><label for="ns1">Nome do cenário</label><input id="ns1" name="name" required></div>
     <div class="f2"><div class="field"><label for="ns2">Pipeline</label><div class="sel"><select id="ns2" name="p">${opt(
       PIPES.map(p => p.name),
       ''
     )}</select></div></div>
     <div class="field"><label for="ns3">Status</label><div class="sel"><select id="ns3" name="s">${opt(['Ativo', 'Inativo'], 'Ativo')}</select></div></div></div>`,
      fd => {
        const next = 'CT-' + String(Math.max(...SCENS.map(s => +s.id.slice(3))) + 1).padStart(3, '0');
        SCENS.push({ id: next, name: fd.get('name').trim(), p: fd.get('p'), s: fd.get('s') });
        saveData();
        renderScens();
        toast(`${next} criado`);
      }
    );
});
