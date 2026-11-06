// QA AI Agent · Modo conectado (?api=): eventos SSE do servidor Jenkins/Jira
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* Eventos reais vindos do servidor (Server-Sent Events) */
const extKey = {},
  extRun = d => extKey[d.job + '#' + d.build];
function extStart(d) {
  if (extRun(d)) return extRun(d);
  // job pode vir como caminho do Jenkins (Pasta/Job): o componente é a última parte
  const short = String(d.job).split('/').pop();
  let p = pipeOf(d.job) || pipeOf(short);
  if (!p) {
    p = {
      name: short,
      group: d.folder || 'Jenkins',
      ico: 'box',
      rate: 100,
      dur: Math.round((d.estimatedDuration || 300000) / 1000),
      scen: d.total || 0,
      tech: d.tech || 'API',
    };
    PIPES.push(p);
  }
  p.job = d.job;
  const sc = (d.scenarios || []).map(n => ({ n, plan: 0, dur: 0, st: 'pend', resp: null }));
  const r = {
    id: +d.build,
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
  logEvent(r, 'start', `#${r.id} iniciada no Jenkins`);
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
  logEvent(r, 'end', `#${r.id} finalizada: ${r.s} (${r.ok}/${r.t}) em ${fmtDur(r.d)}`);
}
if (API) {
  lvAuto = false;
  $('#lvAuto').checked = false;
  $('#lvAuto').parentElement.hidden = true;
  $$('.ptabs [data-go="aovivo"]').forEach(b => {
    b.childNodes[1].textContent = 'Ao vivo · Jenkins';
  });
  const es = new EventSource(API + '/events' + (API_KEY ? '?key=' + encodeURIComponent(API_KEY) : ''));
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
    logEvent(r, 'fail', `Bug ${d.key} ${d.action === 'comment' ? 'atualizado' : 'aberto'} no Jira para ${d.scenario}`);
  });
  let warned = false;
  es.onopen = () => {
    warned = false;
    toast('Conectado ao servidor de tempo real');
  };
  es.onerror = () => {
    if (!warned) {
      warned = true;
      toast('Sem conexão com o servidor de tempo real. Tentando novamente…');
    }
  };
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
function startRunOld(name) {
  const p = PIPES.find(x => x.name === name);
  if (!p) return;
  const r = { id: RUNS[0].id + 1, p: p.name, s: 'Executando', ok: 0, t: p.scen, d: 0, at: new Date(BASE) };
  RUNS.unshift(r);
  toast(`Execução #${r.id} de ${name} iniciada`);
  refresh();
  setTimeout(() => {
    const fail = p.rate < 95 && Math.random() < 0.5;
    r.ok = fail ? p.scen - 1 : p.scen;
    r.s = fail ? 'Falha' : 'Sucesso';
    r.d = p.dur;
    r.at = new Date(BASE.getTime() + 60000 * (RUNS.indexOf(r) + 1));
    refresh();
    toast(`#${r.id} ${name}: ${r.s} (${r.ok}/${r.t})`);
  }, 3500);
}

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
  if (im) {
    const it = INTS.find(x => x.k === im.dataset.intmenu);
    openMenu(im, [
      { t: it.on ? 'Editar configuração' : 'Configurar', f: () => configInt(it) },
      ...(it.on
        ? [
            { t: 'Sincronizar agora', f: () => toast(`${it.name}: sincronização simulada concluída`) },
            {
              t: 'Desconectar',
              danger: true,
              f: () => {
                it.on = false;
                store.set('ints', INTS);
                renderInts();
                toast(`${it.name} desconectado`);
              },
            },
          ]
        : []),
    ]);
  }
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
function configInt(it) {
  if (it.k === 'json') {
    go('execucoes');
    setTimeout(() => $('#importJson').click(), 50);
    return;
  }
  modal(
    `Configurar ${it.name}`,
    `<div class="field"><label for="i1">URL do servidor ou organização</label><input id="i1" name="url" type="url" placeholder="https://" required></div>
   <div class="field"><label for="i2">Projeto</label><input id="i2" name="proj" required></div>
   <div class="field"><label for="i3">Token de acesso</label><input id="i3" name="tok" type="password" autocomplete="off" required><small>Nesta versão MVP o token não é enviado a nenhum serviço.</small></div>`,
    () => {
      it.on = true;
      store.set('ints', INTS);
      renderInts();
      toast(`${it.name} configurado`);
    }
  );
}
