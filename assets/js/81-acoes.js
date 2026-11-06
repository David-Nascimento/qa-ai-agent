// QA AI Agent · Modais, menus, toasts e ações compartilhadas
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- Ações globais ---------- */
/* Recursos de IA: interruptor em Configurações › Geral (desligado por padrão) */
function applyAI() {
  document.body.classList.toggle('no-ai', !CFG.ai);
  if (!CFG.ai && curView() === 'agente') go('dashboard');
}
let toastT;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.hidden = true), 2800);
}
function closeModal() {
  $('#modal').hidden = true;
}
function toastUndo(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span> <button type="button" class="toast-btn">Desfazer</button>`;
  el.hidden = false;
  clearTimeout(toastT);
  el.querySelector('.toast-btn').onclick = () => {
    el.hidden = true;
    undo();
  };
  toastT = setTimeout(() => (el.hidden = true), 8000);
}
function renameFolder(g) {
  modal(
    `Renomear pasta`,
    `<div class="field"><label for="rnF">Novo nome da pasta</label><input id="rnF" name="name" value="${esc(g)}" required></div>`,
    fd => {
      const n = fd.get('name').trim();
      if (!n || n === g) return;
      if (groups().includes(n)) {
        toast(`Já existe uma pasta chamada ${n}. Escolha outro nome.`);
        return false;
      }
      PIPES.forEach(p => {
        if (p.group === g) p.group = n;
      });
      if (AUF.proj === g) AUF.proj = n;
      openF[n] = openF[g];
      saveData();
      renderPipes();
      toast(`Pasta renomeada para ${n}`);
    }
  );
}
function deleteFolder(g) {
  const ps = PIPES.filter(p => p.group === g),
    names = ps.map(p => p.name),
    sc = SCENS.filter(s => names.includes(s.p)),
    running = LIVE.filter(r => names.includes(r.p) && r.s === 'Executando'),
    runs = RUNS.filter(r => names.includes(r.p)).length;
  modal(
    `Excluir a pasta ${esc(g)}`,
    `<p style="margin:0">Isso remove a pasta <b>${esc(g)}</b> e ${ps.length === 1 ? 'o componente' : `os <b>${ps.length} componentes</b>`} dela:</p>
    <ul class="del-list">${ps.map(p => `<li><span>${esc(p.name)}</span>${techBadge(p.tech)}</li>`).join('')}</ul>
    ${running.length ? `<p class="del-warn">${running.length} execução${running.length === 1 ? '' : 'ões'} em andamento ${running.length === 1 ? 'será interrompida' : 'serão interrompidas'}.</p>` : ''}
    <label class="switch-inline"><input type="checkbox" name="scen" checked> Excluir também os ${sc.length} cenário${sc.length === 1 ? '' : 's'} vinculado${sc.length === 1 ? '' : 's'}</label>
    <label class="switch-inline"><input type="checkbox" name="hist"> Apagar também o histórico (${runs} execuç${runs === 1 ? 'ão' : 'ões'})</label>
    <div class="field"><label for="delConfirm">Para confirmar, digite o nome da pasta: <b>${esc(g)}</b></label><input id="delConfirm" name="confirm" autocomplete="off"></div>`,
    fd => {
      if ((fd.get('confirm') || '').trim() !== g) {
        toast('O nome digitado não confere com o da pasta.');
        return false;
      }
      const snap = { pipes: PIPES.map(p => ({ ...p })), scens: SCENS.slice(), runs: RUNS.slice() };
      running.forEach(r => {
        r.live.sc.forEach(c => {
          if (c.st === 'pend' || c.st === 'run') c.st = 'skip';
        });
        r.s = 'Cancelada';
        logEvent(r, 'stop', `#${r.id} interrompida: pasta ${g} excluída`);
      });
      PIPES = PIPES.filter(p => p.group !== g);
      if (fd.get('scen')) SCENS = SCENS.filter(s => !names.includes(s.p));
      if (fd.get('hist')) {
        RUNS = RUNS.filter(r => !names.includes(r.p));
        for (let k = LIVE.length - 1; k >= 0; k--) if (names.includes(LIVE[k].p)) LIVE.splice(k, 1);
      }
      if (AUF.proj === g) AUF.proj = '';
      saveData();
      renderPipes();
      liveRefresh(true, true);
      toastUndo(`Pasta ${g} excluída com ${ps.length} componente${ps.length === 1 ? '' : 's'}.`, () => {
        PIPES = snap.pipes;
        SCENS = snap.scens;
        RUNS = snap.runs;
        saveData();
        renderPipes();
        toast(`Pasta ${g} restaurada`);
      });
    },
    { ok: 'Excluir pasta', danger: true }
  );
}
function modal(title, body, onSubmit, o = {}) {
  $('#modalBox').innerHTML =
    `<div class="mrow"><h3 id="mTitle">${title}</h3><button class="close" data-close aria-label="Fechar">×</button></div><form class="form" id="mForm">${body}<div class="form-foot" style="gap:10px"><button type="button" class="btn-out" data-close>Cancelar</button><button class="btn-pri${o.danger ? ' danger' : ''}" type="submit">${o.ok || 'Salvar'}</button></div></form>`;
  $('#modalBox').setAttribute('aria-labelledby', 'mTitle');
  $('#modal').hidden = false;
  $('#mForm input')?.focus();
  $('#mForm').addEventListener('submit', e => {
    e.preventDefault();
    if (onSubmit(new FormData(e.target)) !== false) closeModal();
  });
}
$('#modal').addEventListener('click', e => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
});
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    $('#menu').hidden = true;
  }
});

function openMenu(btn, items) {
  const m = $('#menu'),
    r = btn.getBoundingClientRect();
  m.innerHTML = items
    .map((it, i) => `<button data-mi="${i}" class="${it.danger ? 'danger' : ''}">${it.t}</button>`)
    .join('');
  m.hidden = false;
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
  m.onclick = e => {
    const b = e.target.closest('[data-mi]');
    if (b) {
      m.hidden = true;
      items[+b.dataset.mi].f();
    }
  };
}
