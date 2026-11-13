// QA AI Agent · Configuração das integrações (Jenkins, GitHub Actions e Jira)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).
//
// Regras desta tela:
//  - o token é SÓ DE ESCRITA: pode ser visto enquanto é digitado (e some sozinho após alguns segundos),
//    mas depois de salvo nunca mais é exibido; o servidor não o devolve e a tela não o guarda
//  - todos os campos são validados na tela (conforto) e de novo no servidor (valem as regras de lá)
//  - a conexão é testada antes de salvar; nada inválido é gravado

let SRV_INT = null; // resposta de GET /api/integrations
const REVEAL_MS = 10000;

const apiHeaders = (json = true) => ({
  ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

/* ---------- validações (mesmas regras do servidor) ---------- */
const VAL = {
  url(v, { opcional = false } = {}) {
    v = (v || '').trim();
    if (!v) return opcional ? '' : 'Informe o endereço (URL).';
    if (v.length > 200) return 'Endereço longo demais (máx. 200 caracteres).';
    let u;
    try {
      u = new URL(v);
    } catch {
      return 'URL inválida. Exemplo: https://jenkins.suaempresa.com';
    }
    if (u.username || u.password) return 'Não coloque usuário e senha na URL; use os campos próprios.';
    if (u.search || u.hash) return 'A URL não pode ter parâmetros (?…) nem âncora (#…).';
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local))
      return 'Use https://. O token iria sem criptografia em http://.';
    return '';
  },
  user: v =>
    /^[\w.@+-]{1,100}$/.test((v || '').trim()) ? '' : 'Informe o usuário (letras, números, ponto, @, + ou hífen).',
  email: v =>
    /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test((v || '').trim()) && v.trim().length <= 254
      ? ''
      : 'Informe um e-mail válido.',
  project: v =>
    /^[A-Z][A-Z0-9_]{1,9}$/.test((v || '').trim()) ? '' : 'Chave inválida: maiúsculas e números, 2 a 10 (ex.: QA).',
  jobs(v) {
    const l = [...new Set(splitList(v))];
    if (!l.length) return 'Informe ao menos um job (um por linha, ex.: Loja/e2e-checkout).';
    if (l.length > 50) return 'No máximo 50 jobs.';
    const bad = l.find(
      j => j.length > 200 || j.split('/').some(s => s === '.' || s === '..' || !/^[A-Za-z0-9._ -]{1,100}$/.test(s))
    );
    return bad ? `Job inválido: "${bad.slice(0, 60)}".` : '';
  },
  workflows(v) {
    const l = [...new Set(splitList(v))];
    if (!l.length) return 'Informe ao menos um workflow (ex.: dono/repo/e2e.yml ou dono/repo).';
    if (l.length > 50) return 'No máximo 50 workflows.';
    const bad = l.find(w => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+\.ya?ml)?$/i.test(w));
    return bad ? `Formato inválido: "${bad.slice(0, 60)}". Use dono/repo ou dono/repo/arquivo.yml.` : '';
  },
  token(v, kind) {
    if (!v) return 'Informe o token.';
    if (/\s/.test(v)) return 'O token não pode ter espaços nem quebras de linha (cole de novo).';
    if (v.length < 8) return 'Token curto demais (mínimo 8 caracteres).';
    if (v.length > 512) return 'Token longo demais (máximo 512 caracteres).';
    if (kind === 'github' && !/^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|[a-f0-9]{40})$/.test(v))
      return 'Não parece um token do GitHub (ghp_…, github_pat_… ou 40 hexadecimais).';
    return '';
  },
};
const splitList = v =>
  String(v || '')
    .split(/[\n,;]+/)
    .map(x => x.trim())
    .filter(Boolean);

// campos de cada integração: [nome, rótulo, tipo, dica]
const INT_FIELDS = {
  jenkins: [
    ['url', 'Endereço do Jenkins', 'url', 'Ex.: https://jenkins.suaempresa.com'],
    ['user', 'Usuário', 'text', 'Use um usuário técnico com permissão mínima.'],
    ['token', 'Token de API', 'secret', ''],
    ['jobs', 'Jobs acompanhados', 'list', 'Um por linha. Pastas com barra: Loja/e2e-checkout.'],
  ],
  github: [
    ['token', 'Token de acesso', 'secret', 'Precisa ler Actions e, para executar/parar, escrever em Actions.'],
    ['workflows', 'Workflows ou repositórios', 'list', 'Um por linha: dono/repo/arquivo.yml, ou dono/repo para todos.'],
    ['api', 'API (GitHub Enterprise)', 'url?', 'Deixe vazio para github.com (https://api.github.com).'],
  ],
  jira: [
    ['url', 'Endereço do Jira', 'url', 'Ex.: https://suaempresa.atlassian.net'],
    ['auth', 'Autenticação', 'auth', ''],
    ['email', 'E-mail do usuário', 'email', 'Usado com o token no modo "e-mail + token".'],
    ['token', 'Token de API', 'secret', ''],
    ['project', 'Chave do projeto', 'project', 'Ex.: QA'],
    ['version', 'Versão da API', 'version', ''],
  ],
};

/* ---------- canal criptografado ---------- */
// A chave da API e os tokens só devem ir ao servidor por HTTPS (ou para a própria máquina).
// O servidor também recusa o que chegar sem criptografia; aqui evitamos nem tentar.
function apiTransport() {
  try {
    const u = new URL(API);
    if (u.protocol === 'https:') return { ok: true, label: 'Conexão criptografada (HTTPS)' };
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      return { ok: true, label: 'Servidor local (mesma máquina)' };
  } catch {
    /* API inválida */
  }
  return { ok: false, label: 'Conexão sem criptografia (http://)' };
}

/* ---------- carga do estado ---------- */
async function loadIntegrations() {
  if (!API) return;
  try {
    const r = await fetch(API + '/api/integrations', { headers: apiHeaders(false) });
    if (r.status === 403 && (await r.json().catch(() => ({}))).code === 'tls_required')
      return toast('O servidor só aceita dados por HTTPS: abra a plataforma com ?api=https://…');
    if (r.status === 404) return legacyIntegrationStatus(); // servidor antigo
    if (!r.ok) return;
    SRV_INT = await r.json();
    INTS.forEach(i => {
      const s = SRV_INT.items[i.k];
      if (!s) return;
      i.on = !!s.configured;
      i.src = s.source;
      i.tokenSet = !!s.tokenSet;
      if (s.url) i.url = s.url;
    });
    renderInts();
  } catch {
    /* sem servidor: mantém o que há */
  }
}
function legacyIntegrationStatus() {
  return fetch(API + '/api/health', { headers: apiHeaders(false) })
    .then(x => x.json())
    .then(h => {
      const on = { jenkins: h.jenkins, github: h.github, jira: h.jira };
      INTS.forEach(i => {
        if (i.k in on) i.on = !!on[i.k];
      });
      renderInts();
    })
    .catch(() => {});
}

/* ---------- formulário ---------- */
const fid = n => 'ig' + n[0].toUpperCase() + n.slice(1);
function fieldHtml([name, label, type, hint], cur, s, ctx) {
  const id = fid(name),
    desc = `${id}Hint ${id}Err`;
  const err = `<small class="err" id="${id}Err" role="alert"></small>`;
  const dis = ctx.locked ? ' disabled' : '';
  const h = hint
    ? `<small class="hint" id="${id}Hint">${esc(hint)}</small>`
    : `<small class="hint" id="${id}Hint"></small>`;
  let input;
  if (type === 'secret') {
    if (s.tokenSet && !ctx.replacing)
      return `<div class="field" id="igTokBox"><label>${label}</label>
        <div class="secret-saved"><span class="mask" role="img" aria-label="Token salvo e oculto">••••••••••••••••</span><span class="saved-tag">salvo no servidor</span>
        ${ctx.locked ? '' : '<button type="button" class="btn-out" id="igReplace">Substituir token</button>'}</div>
        <small class="hint">Por segurança, o token salvo não pode ser exibido de novo. Para trocar, informe um novo.</small></div>`;
    return `<div class="field"><label for="${id}">${label}</label>
      <div class="secret-row"><input id="${id}" name="token" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="512" aria-describedby="${desc}" aria-invalid="false"${dis}>
      <button type="button" class="btn-out" id="igShow" aria-pressed="false" aria-controls="${id}" disabled>Mostrar</button></div>
      <small class="hint" id="${id}Hint">${s.tokenSet ? 'Informe o novo token. ' : ''}Será testado e salvo cifrado no servidor. Você só consegue ver o que digitou enquanto digita; depois de salvo, nunca mais.${hint ? ' ' + esc(hint) : ''}</small>${err}
      ${s.tokenSet ? '<button type="button" class="link-btn" id="igCancelReplace">Manter o token salvo</button>' : ''}</div>`;
  }
  const v = cur[name] ?? '';
  if (type === 'list')
    input = `<textarea id="${id}" name="${name}" rows="3" spellcheck="false" aria-describedby="${desc}" aria-invalid="false"${dis}>${esc(Array.isArray(v) ? v.join('\n') : v)}</textarea>`;
  else if (type === 'auth')
    input = `<div class="sel"><select id="${id}" name="auth" aria-describedby="${desc}"${dis}><option value="basic"${v !== 'bearer' ? ' selected' : ''}>E-mail + token (Cloud)</option><option value="bearer"${v === 'bearer' ? ' selected' : ''}>Token pessoal (Server/Data Center)</option></select></div>`;
  else if (type === 'version')
    input = `<div class="sel"><select id="${id}" name="version" aria-describedby="${desc}"${dis}><option value="3"${v !== '2' ? ' selected' : ''}>3 (Cloud)</option><option value="2"${v === '2' ? ' selected' : ''}>2 (Server/Data Center)</option></select></div>`;
  else
    input = `<input id="${id}" name="${name}" type="${type.startsWith('url') ? 'url' : type === 'email' ? 'email' : 'text'}" value="${esc(String(v))}" maxlength="200" autocomplete="off" spellcheck="false" aria-describedby="${desc}" aria-invalid="false"${dis}>`;
  return `<div class="field" id="${id}Box"><label for="${id}">${label}</label>${input}${h}${err}</div>`;
}

function configInt(it) {
  if (it.k === 'json') {
    go('execucoes');
    setTimeout(() => $('#importJson').click(), 50);
    return;
  }
  if (!INT_FIELDS[it.k])
    return modal(
      `Configurar ${it.name}`,
      `<p style="margin:0">Ainda não há conector para <b>${esc(it.name)}</b>. Ele aparecerá aqui quando for implementado.</p>`,
      () => {},
      { ok: 'Entendi', hideCancel: true }
    );
  if (!API)
    return modal(
      `Configurar ${it.name}`,
      `<p style="margin:0 0 8px">Para configurar integrações, abra a plataforma conectada a um servidor (<code>?api=https://…</code>).</p>
       <p style="margin:0;color:var(--muted)">Senhas e tokens são enviados direto ao servidor, que os guarda cifrados. O navegador não os guarda.</p>`,
      () => {},
      { ok: 'Entendi', hideCancel: true }
    );
  loadIntegrations().then(() => openIntForm(it));
}

function openIntForm(it) {
  const s = (SRV_INT && SRV_INT.items[it.k]) || { k: it.k, configured: false, source: null, tokenSet: false };
  const edit = (SRV_INT && SRV_INT.edit) || { ok: false, reason: 'Servidor sem suporte à configuração pela tela.' };
  const fromEnv = s.source === 'env';
  const tr = apiTransport();
  const ctx = { replacing: false, locked: !edit.ok || fromEnv || !tr.ok };
  const notice = !tr.ok
    ? 'Esta conexão com o servidor não é criptografada (<code>http://</code>). Por segurança o token só é enviado por HTTPS: abra a plataforma com <code>?api=https://…</code>.'
    : fromEnv
      ? 'Esta integração vem do <code>.env</code> do servidor. Para alterar, edite o arquivo e reinicie o servidor.'
      : !edit.ok
        ? esc(edit.reason)
        : '';
  const render = () => {
    $('#igFields').innerHTML = INT_FIELDS[it.k].map(f => fieldHtml(f, s, s, ctx)).join('');
    wire();
  };
  modal(
    `${s.configured ? 'Editar' : 'Configurar'} ${esc(it.name)}`,
    `<p class="int-lock ${tr.ok ? 'ok' : 'bad'}" role="status">${tr.ok ? '🔒' : '⚠️'} ${tr.label}</p>${notice ? `<p class="int-note" role="note">${notice}</p>` : ''}<div id="igFields"></div>
     <div id="igResult" class="int-result" role="status" aria-live="polite"></div>
     <div class="int-actions"><button type="button" class="btn-out" id="igTest">Testar conexão</button></div>`,
    () => {
      save();
      return false;
    },
    { ok: ctx.locked ? 'Fechar' : 'Testar e salvar' }
  );
  const $f = n => document.getElementById(fid(n));
  const setErr = (n, msg) => {
    const e = document.getElementById(fid(n) + 'Err'),
      i = $f(n);
    if (e) e.textContent = msg || '';
    if (i) i.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const result = (msg, ok) => {
    const r = $('#igResult');
    r.textContent = msg || '';
    r.className = 'int-result' + (msg ? (ok ? ' ok' : ' bad') : '');
  };
  const read = () => {
    const o = {};
    for (const [n, , t] of INT_FIELDS[it.k]) {
      const el = $f(n);
      if (!el) continue;
      o[n] = t === 'secret' ? el.value : el.value.trim();
    }
    return o;
  };
  // valida na tela; devolve true se tudo certo
  const check = (o, needToken) => {
    let first = null;
    for (const [n, , t] of INT_FIELDS[it.k]) {
      if (!$f(n) && t !== 'secret') continue;
      let m = '';
      if (t === 'secret') m = $f(n) ? (o.token || needToken ? VAL.token(o.token, it.k) : '') : '';
      else if (t === 'url' || t === 'url?') m = VAL.url(o[n], { opcional: t === 'url?' });
      else if (t === 'text') m = VAL.user(o[n]);
      else if (t === 'email') m = o.auth === 'bearer' ? '' : VAL.email(o[n]);
      else if (t === 'project') m = VAL.project(o[n]);
      else if (t === 'list') m = VAL[n](o[n]);
      setErr(n, m);
      if (m && !first) first = n;
    }
    if (first) $f(first)?.focus();
    return !first;
  };
  const showServerErrors = j => {
    let first = null;
    for (const [n, m] of Object.entries(j.errors || {})) {
      setErr(n, m);
      first = first || n;
    }
    result(j.error || 'Não foi possível concluir.', false);
    if (first) $f(first)?.focus();
  };
  const busy = on => {
    $('#igTest').disabled = on;
    const b = $('#mForm .btn-pri');
    b.disabled = on;
    if (on) b.dataset.t = b.textContent;
    b.textContent = on ? 'Aguarde…' : b.dataset.t || b.textContent;
  };
  const hideSecret = () => {
    const i = $f('token'),
      b = $('#igShow');
    if (!i || !b) return;
    i.type = 'password';
    b.textContent = 'Mostrar';
    b.setAttribute('aria-pressed', 'false');
    clearTimeout(hideSecret.t);
  };
  const wipeSecret = () => {
    hideSecret();
    const i = $f('token');
    if (i) i.value = '';
  };
  function wire() {
    const tok = $f('token'),
      show = $('#igShow');
    if (tok && show) {
      tok.addEventListener('input', () => {
        show.disabled = !tok.value;
        if (!tok.value) hideSecret();
      });
      // some quando o foco sai do par campo+botão (clicar em "Mostrar" move o foco para o botão, e isso não conta)
      tok.parentElement.addEventListener('focusout', e => {
        if (!tok.parentElement.contains(e.relatedTarget)) hideSecret();
      });
      show.addEventListener('click', () => {
        const reveal = tok.type === 'password';
        if (!reveal) return hideSecret();
        tok.type = 'text';
        show.textContent = 'Ocultar';
        show.setAttribute('aria-pressed', 'true');
        clearTimeout(hideSecret.t);
        hideSecret.t = setTimeout(hideSecret, REVEAL_MS); // volta a mascarar sozinho
      });
    }
    $('#igReplace')?.addEventListener('click', () => {
      ctx.replacing = true;
      render();
      $f('token')?.focus();
    });
    $('#igCancelReplace')?.addEventListener('click', () => {
      wipeSecret();
      ctx.replacing = false;
      render();
    });
    const auth = $f('auth');
    if (auth) {
      const sync = () => {
        const bearer = auth.value === 'bearer';
        const e = $f('email');
        if (e) {
          e.disabled = ctx.locked || bearer;
          if (bearer) setErr('email', '');
        }
      };
      auth.addEventListener('change', sync);
      sync();
    }
    // validação ao sair do campo
    for (const [n, , t] of INT_FIELDS[it.k]) {
      const el = $f(n);
      if (!el || t === 'secret' || t === 'auth' || t === 'version') continue;
      el.addEventListener('blur', () => {
        const o = read();
        const m =
          t === 'url' || t === 'url?'
            ? VAL.url(o[n], { opcional: t === 'url?' })
            : t === 'text'
              ? VAL.user(o[n])
              : t === 'email'
                ? o.auth === 'bearer'
                  ? ''
                  : VAL.email(o[n])
                : t === 'project'
                  ? VAL.project(o[n])
                  : VAL[n]?.(o[n]) || '';
        setErr(n, m);
      });
    }
  }
  async function send(path, method, body) {
    const r = await fetch(API + path, {
      method,
      headers: apiHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 && j.code === 'tls_required') j.error = j.error + ' (use ?api=https://…)';
    return { ok: r.ok, status: r.status, j };
  }
  // dados a enviar: o token só vai se foi digitado agora (o salvo fica no servidor)
  const payload = o => {
    const b = { ...o };
    if (!b.token) delete b.token;
    return b;
  };
  async function test() {
    result('');
    const o = read();
    const needToken = !(s.tokenSet && !ctx.replacing);
    if (!ctx.locked && !check(o, needToken)) return;
    busy(true);
    hideSecret();
    try {
      const r = await send(`/api/integrations/${it.k}/test`, 'POST', ctx.locked ? {} : payload(o));
      if (r.ok) result('✓ ' + r.j.detail, true);
      else showServerErrors(r.j);
    } catch {
      result('Não consegui falar com o servidor.', false);
    } finally {
      busy(false);
    }
  }
  async function save() {
    if (ctx.locked) return closeModal();
    result('');
    const o = read();
    const needToken = !(s.tokenSet && !ctx.replacing);
    if (!check(o, needToken)) return;
    busy(true);
    hideSecret();
    try {
      const r = await send(`/api/integrations/${it.k}`, 'PUT', payload(o));
      if (r.ok) {
        wipeSecret(); // apaga o que foi digitado antes de fechar
        closeModal();
        toast(`${it.name}: conexão testada e salva (token cifrado no servidor)`);
        await loadIntegrations();
        return;
      }
      showServerErrors(r.j);
    } catch {
      result('Não consegui falar com o servidor.', false);
    } finally {
      if (!$('#modal').hidden) busy(false);
    }
  }
  $('#igTest').addEventListener('click', test);
  $('#igTest').hidden = false;
  // fechar o modal apaga qualquer token digitado e não salvo
  const clear = e => {
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) wipeSecret();
  };
  $('#modal').addEventListener('click', clear, { once: true });
  render();
}

/* ---------- menu (⋮) de cada integração ---------- */
function intMenuItems(it) {
  const items = [{ t: it.on ? 'Editar configuração' : 'Configurar', f: () => configInt(it) }];
  if (!API || !INT_FIELDS[it.k] || !it.on) return items;
  items.push({
    t: 'Testar conexão',
    f: async () => {
      toast(`${it.name}: testando…`);
      try {
        const r = await fetch(`${API}/api/integrations/${it.k}/test`, {
          method: 'POST',
          headers: apiHeaders(),
          body: '{}',
        });
        const j = await r.json().catch(() => ({}));
        toast(r.ok ? `${it.name}: ${j.detail}` : `${it.name}: ${j.error || 'falhou'}`);
      } catch {
        toast(`${it.name}: sem resposta do servidor`);
      }
    },
  });
  if (it.k === 'jira')
    items.push({
      t: 'Sincronizar agora',
      f: async () => {
        try {
          const r = await fetch(API + '/api/jira/sync', { method: 'POST', headers: apiHeaders(), body: '{}' });
          const j = await r.json().catch(() => ({}));
          toast(
            r.ok
              ? j.throttled
                ? 'Sincronizado há pouco; aguarde alguns segundos'
                : 'Jira sincronizado'
              : j.error || 'Falha ao sincronizar'
          );
          if (r.ok && typeof loadJiraState === 'function') loadJiraState();
        } catch {
          toast('Jira: sem resposta do servidor');
        }
      },
    });
  items.push({
    t: 'Desconectar',
    danger: true,
    f: () => {
      if (it.src === 'env') return toast(`${it.name} vem do .env do servidor: edite o arquivo para desconectar`);
      modal(
        `Desconectar ${esc(it.name)}`,
        `<p style="margin:0">Isso apaga o token salvo no servidor e para o acompanhamento de ${esc(it.name)}. Para reconectar será preciso informar o token de novo.</p>`,
        () => {
          fetch(`${API}/api/integrations/${it.k}`, { method: 'DELETE', headers: apiHeaders(false) })
            .then(async r => {
              toast(
                r.ok ? `${it.name} desconectado` : (await r.json().catch(() => ({}))).error || 'Falha ao desconectar'
              );
              loadIntegrations();
            })
            .catch(() => toast('Sem resposta do servidor'));
          return true;
        },
        { ok: 'Desconectar', danger: true }
      );
    },
  });
  return items;
}
