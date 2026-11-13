// Cofre de integrações: configura Jenkins, GitHub Actions e Jira pela tela sem expor o token.
//  - o token é SÓ DE ESCRITA: entra uma vez, é testado, cifrado (AES-256-GCM) e gravado; nenhuma rota o devolve
//  - toda entrada é validada aqui (a validação da tela é só conforto)
//  - a conexão é testada antes de salvar; nada inválido é gravado
//  - só edita com chave da API ativa e chave-mestra configurada; integrações vindas do .env são somente leitura
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CFG, SECRET_VALUES, b64, env, getMaster, isLoopback, log, redact } from './config.js';
import { abrir, selar } from './cripto.js';
import { jobPath } from './jenkins.js';
import { jiraReady } from './jira.js';
import { ghReady } from './github.js';
import { authRequired, clientError, readJson, send } from './web.js';

export const KINDS = ['jenkins', 'github', 'jira'];
const FILE = CFG.integrations.file;
let onChange = () => {};
export const setOnChange = fn => (onChange = fn);

/* ---------- validações (espelhadas na tela, mas valem as daqui) ---------- */
const RX = {
  user: /^[\w.@+-]{1,100}$/,
  email: /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/,
  project: /^[A-Z][A-Z0-9_]{1,9}$/,
  jobSeg: /^[A-Za-z0-9._ -]{1,100}$/,
  ghWorkflow: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+\.ya?ml)?$/i,
  ghToken: /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|[a-f0-9]{40})$/,
};
const lista = v => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map(x => String(x).trim()).filter(Boolean);

export function checkUrl(v, { opcional = false } = {}) {
  const t = String(v ?? '').trim();
  if (!t) return opcional ? { ok: '' } : { erro: 'Informe o endereço (URL).' };
  if (t.length > 200) return { erro: 'Endereço longo demais (máx. 200 caracteres).' };
  let u;
  try {
    u = new URL(t);
  } catch {
    return { erro: 'URL inválida. Exemplo: https://jenkins.suaempresa.com' };
  }
  if (u.username || u.password) return { erro: 'Não coloque usuário e senha na URL; use os campos próprios.' };
  if (u.search || u.hash) return { erro: 'A URL não pode ter parâmetros (?…) nem âncora (#…).' };
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && (isLoopback(u.hostname) || CFG.security.allowInsecureUpstream))
  )
    return { erro: 'Use https://. O token iria sem criptografia em http://.' };
  if (/^169\.254\./.test(u.hostname)) return { erro: 'Endereço não permitido.' };
  return { ok: t.replace(/\/+$/, '') };
}
export function checkToken(k, v) {
  const t = String(v ?? '');
  if (!t) return { erro: 'Informe o token.' };
  if (t !== t.trim() || /\s/.test(t))
    return { erro: 'O token não pode ter espaços nem quebras de linha (cole de novo).' };
  if (t.length < 8) return { erro: 'Token curto demais (mínimo 8 caracteres).' };
  if (t.length > 512) return { erro: 'Token longo demais (máximo 512 caracteres).' };
  if (k === 'github' && !RX.ghToken.test(t))
    return { erro: 'Não parece um token do GitHub (ghp_…, github_pat_… ou 40 caracteres hexadecimais).' };
  return { ok: t };
}
export function checkJobs(v) {
  const jobs = [...new Set(lista(v))];
  if (!jobs.length) return { erro: 'Informe ao menos um job (um por linha, ex.: Loja/e2e-checkout).' };
  if (jobs.length > 50) return { erro: 'No máximo 50 jobs.' };
  for (const j of jobs) {
    const segs = j.split('/');
    if (j.length > 200 || segs.some(s => s === '.' || s === '..' || !RX.jobSeg.test(s)))
      return {
        erro: `Job inválido: "${j.slice(0, 60)}". Use Pasta/Job com letras, números, espaço, ponto, hífen ou sublinhado.`,
      };
  }
  return { ok: jobs };
}
export function checkWorkflows(v) {
  const ws = [...new Set(lista(v))];
  if (!ws.length) return { erro: 'Informe ao menos um workflow (ex.: dono/repo/e2e.yml ou dono/repo).' };
  if (ws.length > 50) return { erro: 'No máximo 50 workflows.' };
  const ruim = ws.find(w => !RX.ghWorkflow.test(w));
  return ruim
    ? { erro: `Formato inválido: "${ruim.slice(0, 60)}". Use dono/repo ou dono/repo/arquivo.yml.` }
    : { ok: ws };
}

/* ---------- estado atual (nunca inclui o token) ---------- */
const PUBLIC = {
  jenkins: () => ({ url: CFG.jenkins.url, user: CFG.jenkins.user, jobs: CFG.jenkins.jobs }),
  github: () => ({ api: CFG.github.api, workflows: CFG.github.workflows }),
  jira: () => ({
    url: CFG.jira.url,
    auth: CFG.jira.auth,
    email: CFG.jira.email,
    project: CFG.jira.project,
    version: CFG.jira.version,
  }),
};
const fromEnv = k =>
  k === 'jenkins'
    ? !!(env.JENKINS_URL && env.JENKINS_TOKEN)
    : k === 'github'
      ? !!env.GITHUB_TOKEN
      : !!(env.JIRA_URL && env.JIRA_TOKEN);
const ready = k =>
  k === 'jenkins'
    ? !!(CFG.jenkins.url && CFG.jenkins.token && CFG.jenkins.jobs.length)
    : k === 'github'
      ? ghReady()
      : !!jiraReady();
const saved = {}; // k → true quando a configuração atual veio do arquivo cifrado

export function canEdit() {
  if (CFG.demo) return { ok: false, reason: 'Modo DEMO: não há integrações reais.' };
  if (!FILE) return { ok: false, reason: 'Edição pela tela desligada (INTEGRATIONS_FILE=off).' };
  if (!authRequired())
    return { ok: false, reason: 'Defina API_KEY ou API_KEY_HASH no servidor para editar pela tela.' };
  if (!getMaster())
    return { ok: false, reason: 'Defina SECRETS_KEY_FILE no servidor: os tokens são gravados cifrados.' };
  return { ok: true };
}
export function status(k) {
  const source = fromEnv(k) ? 'env' : saved[k] ? 'ui' : null;
  return { k, configured: ready(k), source, tokenSet: !!CFG[k].token, ...PUBLIC[k]() };
}
export const statusAll = () => ({ edit: canEdit(), items: Object.fromEntries(KINDS.map(k => [k, status(k)])) });

/* ---------- aplicar na memória ---------- */
const lastToken = {};
function trackSecret(k, token) {
  const i = SECRET_VALUES.indexOf(lastToken[k]);
  if (i >= 0) SECRET_VALUES.splice(i, 1);
  lastToken[k] = token && token.length >= 6 ? token : undefined;
  if (lastToken[k]) SECRET_VALUES.push(token);
}
function apply(k, d, token) {
  if (k === 'jenkins') Object.assign(CFG.jenkins, { url: d.url, user: d.user, jobs: d.jobs, token });
  if (k === 'github') Object.assign(CFG.github, { api: d.api, workflows: d.workflows, token });
  if (k === 'jira')
    Object.assign(CFG.jira, {
      url: d.url,
      auth: d.auth,
      email: d.email,
      project: d.project,
      version: d.version,
      token,
    });
  trackSecret(k, token);
}
const RESET = {
  jenkins: { url: '', user: '', jobs: [] },
  github: { api: 'https://api.github.com', workflows: [] },
  jira: { url: '', email: '', project: '' },
};

/* ---------- arquivo cifrado ---------- */
function readStore() {
  if (!FILE || !existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')).items || {};
  } catch (e) {
    log(`Integrações: arquivo ilegível (${e.message}); ignorando`);
    return {};
  }
}
function writeStore(items) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ v: 1, items }), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}
// o nome da integração vai junto do token cifrado: trocar blocos entre integrações no arquivo não funciona
const sealToken = (k, token) => selar(`${k}\n${token}`, getMaster());
function openToken(k, enc) {
  const [name, ...rest] = abrir(enc, getMaster()).split('\n');
  if (name !== k) throw new Error('token cifrado pertence a outra integração');
  return rest.join('\n');
}
export function loadIntegrations() {
  if (!FILE || CFG.demo) return;
  const items = readStore();
  for (const k of KINDS) {
    const it = items[k];
    if (!it || fromEnv(k)) continue;
    if (!getMaster()) {
      log(`Integrações: ${k} está salva, mas falta SECRETS_KEY_FILE para decifrar; ignorando`);
      continue;
    }
    try {
      const { token: enc, ...pub } = it;
      apply(k, pub, openToken(k, enc));
      saved[k] = true;
      log(`Integrações: ${k} carregada do arquivo cifrado`);
    } catch (e) {
      log(`Integrações: não consegui abrir ${k} (${e.message}); ignorando`);
    }
  }
}

/* ---------- validar formulário ---------- */
function validar(k, b, { usarAtual = false } = {}) {
  const erros = {};
  const d = {};
  const pega = (campo, r) => (r.erro ? (erros[campo] = r.erro) : (d[campo] = r.ok));
  const atual = PUBLIC[k]();
  const campo = n => (usarAtual && b[n] === undefined ? atual[n] : b[n]);
  if (k === 'jenkins') {
    pega('url', checkUrl(campo('url')));
    const u = String(campo('user') ?? '').trim();
    if (!RX.user.test(u)) erros.user = 'Informe o usuário (letras, números, ponto, @, + ou hífen; até 100).';
    else d.user = u;
    pega('jobs', checkJobs(campo('jobs')));
  } else if (k === 'github') {
    pega('api', checkUrl(campo('api') || 'https://api.github.com'));
    pega('workflows', checkWorkflows(campo('workflows')));
  } else {
    pega('url', checkUrl(campo('url')));
    const auth = campo('auth') || 'basic';
    if (!['basic', 'bearer'].includes(auth))
      erros.auth = 'Escolha "basic" (e-mail + token) ou "bearer" (token pessoal).';
    else d.auth = auth;
    const email = String(campo('email') ?? '').trim();
    if (d.auth === 'basic' && (!RX.email.test(email) || email.length > 254)) erros.email = 'Informe um e-mail válido.';
    else d.email = email;
    const proj = String(campo('project') ?? '').trim();
    if (!RX.project.test(proj))
      erros.project = 'Chave do projeto inválida: letras maiúsculas e números, 2 a 10 (ex.: QA).';
    else d.project = proj;
    const ver = String(campo('version') || '3');
    if (!['2', '3'].includes(ver)) erros.version = 'Versão da API: 2 (Server/Data Center) ou 3 (Cloud).';
    else d.version = ver;
  }
  return { erros, d };
}
const endpoint = (k, d) => (k === 'github' ? d.api : d.url);

// Token: o informado agora; ou o já salvo, mas só se o endereço não mudou (senão dava para desviar o token salvo)
function resolverToken(k, b, d, erros) {
  if (b.token) {
    const r = checkToken(k, b.token);
    if (r.erro) erros.token = r.erro;
    return r.ok;
  }
  if (CFG[k].token && (saved[k] || fromEnv(k)) && endpoint(k, d) === endpoint(k, PUBLIC[k]())) return CFG[k].token;
  erros.token = CFG[k].token ? 'O endereço mudou: informe o token de novo.' : 'Informe o token.';
  return undefined;
}

/* ---------- testar a conexão ---------- */
const falha = (msg, field) => Object.assign(new Error(msg), { field });
async function chamar(url, headers) {
  try {
    return await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
  } catch (e) {
    const host = new URL(url).host;
    const code = e.name === 'TimeoutError' ? 'tempo esgotado' : e.cause?.code || 'erro de rede';
    throw falha(`Não consegui conectar a ${host} (${redact(String(code))}). Confira o endereço e a rede.`, 'url');
  }
}
function exigirOk(res, campoCred) {
  if (res.ok) return;
  if (res.status === 401) throw falha('Credenciais recusadas (401): confira usuário/e-mail e token.', campoCred);
  if (res.status === 403) throw falha('Acesso negado (403): o token não tem permissão para isso.', campoCred);
  if (res.status === 404) throw falha('Endereço não encontrado (404): confira a URL.', 'url');
  throw falha(`Resposta inesperada do servidor (HTTP ${res.status}).`, 'url');
}
export async function probe(k, d, token) {
  if (k === 'jenkins') {
    const h = { Authorization: 'Basic ' + b64(`${d.user}:${token}`) };
    exigirOk(await chamar(`${d.url}/api/json?tree=mode`, h), 'token');
    for (const job of d.jobs.slice(0, 10)) {
      const r = await chamar(`${d.url}/${jobPath(job)}/api/json?tree=name`, h);
      if (r.status === 404) throw falha(`Job "${job}" não existe neste Jenkins.`, 'jobs');
      exigirOk(r, 'token');
    }
    return `Jenkins respondeu e ${Math.min(d.jobs.length, 10)} job(s) conferido(s).`;
  }
  if (k === 'github') {
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'qa-ai-agent' };
    let rate = '';
    for (const w of d.workflows.slice(0, 10)) {
      const [dono, repo, file] = w.split('/');
      const r = await chamar(
        `${d.api}/repos/${dono}/${repo}${file ? `/actions/workflows/${encodeURIComponent(file)}` : ''}`,
        h
      );
      if (r.status === 401) throw falha('Token inválido ou expirado (401).', 'token');
      if (r.status === 404) throw falha(`"${w}" não encontrado, ou o token não tem acesso a ele.`, 'workflows');
      exigirOk(r, 'token');
      rate = r.headers.get('x-ratelimit-remaining')
        ? ` · restam ${r.headers.get('x-ratelimit-remaining')} chamadas/h`
        : rate;
    }
    return `GitHub respondeu e ${Math.min(d.workflows.length, 10)} workflow(s)/repositório(s) conferido(s)${rate}.`;
  }
  const h = {
    Authorization: d.auth === 'bearer' ? `Bearer ${token}` : 'Basic ' + b64(`${d.email}:${token}`),
    Accept: 'application/json',
  };
  const base = `${d.url}/rest/api/${d.version}`;
  const me = await chamar(`${base}/myself`, h);
  exigirOk(me, 'token');
  const pr = await chamar(`${base}/project/${encodeURIComponent(d.project)}`, h);
  if (pr.status === 404) throw falha(`Projeto "${d.project}" não encontrado, ou sem permissão.`, 'project');
  exigirOk(pr, 'token');
  return `Jira respondeu e o projeto ${d.project} está acessível.`;
}

/* ---------- rotas ---------- */
let ocupado = false;
export async function rota(req, res, m, ip) {
  const [, k, test] = m;
  if (!k) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Método não permitido' });
    return send(res, 200, statusAll());
  }
  const body = req.method === 'DELETE' ? {} : await readJson(req);
  if (req.method === 'POST' && test) {
    // sem campos: testa a configuração atual; com campos: testa o que está no formulário (sem salvar)
    const vazio = !Object.keys(body).length;
    const { erros, d } = validar(k, body, { usarAtual: vazio });
    const token = vazio ? CFG[k].token : resolverToken(k, body, d, erros);
    if (vazio && !ready(k)) return send(res, 400, { error: 'Esta integração ainda não está configurada.' });
    if (Object.keys(erros).length) return send(res, 400, { error: 'Corrija os campos destacados.', errors: erros });
    try {
      return send(res, 200, { ok: true, detail: await probe(k, d, token) });
    } catch (e) {
      return send(res, 422, { error: redact(e.message), errors: e.field ? { [e.field]: redact(e.message) } : {} });
    }
  }
  const ed = canEdit();
  if (!ed.ok) throw clientError(409, ed.reason);
  if (fromEnv(k)) throw clientError(409, 'Esta integração vem do .env do servidor; altere o arquivo e reinicie.');
  if (ocupado) throw clientError(409, 'Outra alteração está em andamento; tente de novo.');
  ocupado = true;
  try {
    const items = readStore();
    if (req.method === 'DELETE') {
      delete items[k];
      writeStore(items);
      apply(k, RESET[k], '');
      delete saved[k];
      log(`Integração ${k} removida (origem ${ip})`);
      onChange(k);
      return send(res, 200, status(k));
    }
    if (req.method !== 'PUT') return send(res, 405, { error: 'Método não permitido' });
    const { erros, d } = validar(k, body);
    const token = resolverToken(k, body, d, erros);
    if (Object.keys(erros).length) return send(res, 400, { error: 'Corrija os campos destacados.', errors: erros });
    try {
      await probe(k, d, token);
    } catch (e) {
      return send(res, 422, { error: redact(e.message), errors: e.field ? { [e.field]: redact(e.message) } : {} });
    }
    items[k] = { ...d, token: sealToken(k, token) };
    writeStore(items);
    apply(k, d, token);
    saved[k] = true;
    log(`Integração ${k} salva (origem ${ip})`);
    onChange(k);
    return send(res, 200, status(k));
  } finally {
    ocupado = false;
  }
}
