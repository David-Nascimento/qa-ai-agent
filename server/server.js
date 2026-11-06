// QA AI Agent — servidor de tempo real
// Lê as execuções do Jenkins e integra com o Jira usando somente as APIs REST,
// e envia os eventos para a plataforma via Server-Sent Events (SSE).
// Requer Node.js 20.6+ (fetch nativo e --env-file). Sem dependências externas.

import http from 'node:http';

const env = process.env;
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

const CFG = {
  port: +(env.PORT || 3000),
  cors: env.CORS_ORIGIN || '*',
  apiKey: env.API_KEY || '',
  demo: env.DEMO === 'true',
  jenkins: {
    url: (env.JENKINS_URL || '').replace(/\/$/, ''),
    user: env.JENKINS_USER || '',
    token: env.JENKINS_TOKEN || '',
    jobs: list(env.JENKINS_JOBS),
    pollMs: +(env.POLL_MS || 3000),
    discoverMs: +(env.DISCOVER_MS || 30000),
    logRegex: env.LOG_REGEX ? new RegExp(env.LOG_REGEX, 'u') : null,
    respRegex: new RegExp(env.RESP_REGEX || String.raw`\[resp\]\s+(?<name>.+?)\s+(?<ms>\d+)\s*ms`, 'u'),
  },
  jira: {
    url: (env.JIRA_URL || '').replace(/\/$/, ''),
    email: env.JIRA_EMAIL || '',
    token: env.JIRA_TOKEN || '',
    project: env.JIRA_PROJECT || '',
    version: env.JIRA_API_VERSION || '3',
    autoBug: env.JIRA_AUTO_BUG === 'true',
    issueType: env.JIRA_ISSUE_TYPE || 'Bug',
    labels: list(env.JIRA_LABELS || 'qa-ai-agent'),
    scenarioJql: env.JIRA_SCENARIOS_JQL || 'project = QA AND issuetype = Test ORDER BY key',
    pipelineField: env.JIRA_PIPELINE_FIELD || 'components',
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = s => Buffer.from(s).toString('base64');
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ */
/* Eventos (SSE)                                                       */
/* ------------------------------------------------------------------ */
const clients = new Set();
const recent = [];            // últimos eventos, reenviados a quem conecta
const MAX_RECENT = 300;

function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  recent.push(msg);
  if (recent.length > MAX_RECENT) recent.shift();
  for (const res of clients) res.write(msg);
}

/* ------------------------------------------------------------------ */
/* Jenkins                                                             */
/* ------------------------------------------------------------------ */
const jobPath = job => job.split('/').map(s => 'job/' + encodeURIComponent(s)).join('/');
const jenkinsHeaders = () => ({ Authorization: 'Basic ' + b64(`${CFG.jenkins.user}:${CFG.jenkins.token}`) });

async function jenkinsRaw(path, opts = {}) {
  const res = await fetch(CFG.jenkins.url + path, { ...opts, headers: { ...jenkinsHeaders(), ...(opts.headers || {}) } });
  if (!res.ok) { const e = new Error(`Jenkins ${res.status} em ${path}`); e.status = res.status; throw e; }
  return res;
}
const jenkinsJson = async path => (await jenkinsRaw(path)).json();

// Formatos reconhecidos por padrão (Playwright "list", Cypress/Mocha "spec", Jest, TAP):
//   ✓  3 [chromium] › checkout.spec.ts:12:5 › CT-001 Fluxo de compra completo (1.2s)
//   ✘  4 [chromium] › checkout.spec.ts:30:5 › CT-004 Timeout na API de pagamento (30.0s)
//   ✓ CT-002 Aplicar cupom de desconto (842ms)
const DEFAULT_LINE = /^\s*(?<status>✓|✔|√|✗|✘|×|✕)\s+(?:\d+\s+)?(?<name>.+?)\s*\((?<dur>\d+(?:[.,]\d+)?)\s*(?<unit>ms|s|m)\)\s*$/u;
const PASS = new Set(['✓', '✔', '√', 'ok', 'OK', 'pass', 'passed', 'PASS', 'PASSED', 'Passed', 'SUCCESS']);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function toSeconds(v, unit) {
  const n = parseFloat(String(v).replace(',', '.'));
  return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : n;
}
function cleanName(name) {
  // remove o prefixo "[chromium] › arquivo.spec.ts:12:5 › " do Playwright
  const parts = name.split(' › ');
  return parts.length > 1 ? parts.slice(-1)[0].trim() : name.trim();
}
function respFor(st, name) {
  if (st.resp.has(name)) return st.resp.get(name);
  const id = name.match(/CT-\d+/)?.[0];
  if (!id) return null;
  for (const [k, v] of st.resp) if (k.includes(id)) return v;
  return null;
}

function parseLines(st, text, final) {
  const chunk = st.buf + text;
  const lines = chunk.split(/\r?\n/);
  st.buf = final ? '' : lines.pop();
  const re = CFG.jenkins.logRegex || DEFAULT_LINE;
  for (const raw of lines) {
    const line = raw.replace(ANSI, '');
    const r = line.match(CFG.jenkins.respRegex);
    if (r?.groups) { st.resp.set(cleanName(r.groups.name), +r.groups.ms); continue; }
    const m = line.match(re);
    if (!m?.groups) continue;
    const name = cleanName(m.groups.name);
    const status = PASS.has(m.groups.status) ? 'pass' : 'fail';
    const duration = m.groups.dur ? +toSeconds(m.groups.dur, m.groups.unit || 's').toFixed(2) : 0;
    st.scen.set(name, status);
    emit('scenario', {
      job: st.job, build: st.build, name, status, duration,
      resp: respFor(st, name), elapsed: Math.round((Date.now() - st.start) / 1000),
    });
  }
}

async function pollStages(st) {
  if (st.noStages) return;
  try {
    const d = await jenkinsJson(`/${jobPath(st.job)}/${st.build}/wfapi/describe`);
    for (const s of d.stages || []) {
      if (st.stages[s.name] !== s.status) {
        st.stages[s.name] = s.status;
        emit('stage', { job: st.job, build: st.build, stage: s.name, status: s.status, duration: s.durationMillis });
      }
    }
  } catch (e) {
    if (e.status === 404) st.noStages = true; // plugin Pipeline Stage View ausente
  }
}

const active = new Map();

async function track(job, b) {
  const key = `${job}#${b.number}`;
  const st = { job, build: b.number, offset: 0, buf: '', start: b.timestamp || Date.now(), scen: new Map(), resp: new Map(), stages: {} };
  active.set(key, st);
  log(`Acompanhando ${key}`);
  emit('build_start', {
    job, build: b.number, timestamp: st.start, estimatedDuration: b.estimatedDuration,
    folder: job.includes('/') ? job.split('/').slice(0, -1).join('/') : undefined,
    url: `${CFG.jenkins.url}/${jobPath(job)}/${b.number}/`,
  });
  try {
    let more = true;
    while (more) {
      const res = await jenkinsRaw(`/${jobPath(job)}/${b.number}/logText/progressiveText?start=${st.offset}`);
      const text = await res.text();
      st.offset = +(res.headers.get('x-text-size') || st.offset);
      more = res.headers.get('x-more-data') === 'true';
      parseLines(st, text, !more);
      await pollStages(st);
      if (more) await sleep(CFG.jenkins.pollMs);
    }
    await finish(st);
  } catch (e) {
    log(`Erro em ${key}: ${e.message}`);
    emit('build_end', { job, build: b.number, status: 'Falha', error: e.message });
  } finally {
    active.delete(key);
  }
}

async function finish(st) {
  const base = `/${jobPath(st.job)}/${st.build}`;
  const info = await jenkinsJson(`${base}/api/json?tree=result,duration`).catch(() => ({}));
  let tr = null;
  try { tr = await jenkinsJson(`${base}/testReport/api/json?tree=passCount,failCount,skipCount`); } catch { /* sem relatório JUnit */ }
  const fromLog = [...st.scen.values()];
  const passed = tr?.passCount ?? fromLog.filter(s => s === 'pass').length;
  const failed = tr?.failCount ?? fromLog.filter(s => s === 'fail').length;
  const total = passed + failed + (tr?.skipCount || 0);
  const status = info.result === 'ABORTED' ? 'Cancelada' : (info.result === 'SUCCESS' && failed === 0 ? 'Sucesso' : 'Falha');
  emit('build_end', { job: st.job, build: st.build, status, duration: info.duration || Date.now() - st.start, passed, failed, total, result: info.result });
  log(`${st.job}#${st.build} finalizado: ${status} (${passed}/${total})`);

  if (CFG.jira.autoBug && jiraReady()) {
    for (const [name, s] of st.scen) {
      if (s !== 'fail') continue;
      await reportBug({ job: st.job, build: st.build, scenario: name, buildUrl: `${CFG.jenkins.url}${base}/` })
        .catch(e => log(`Jira: ${e.message}`));
    }
  }
}

async function discover() {
  for (const job of CFG.jenkins.jobs) {
    try {
      const d = await jenkinsJson(`/${jobPath(job)}/api/json?tree=builds[number,building,timestamp,estimatedDuration]{0,5}`);
      for (const b of d.builds || []) if (b.building && !active.has(`${job}#${b.number}`)) track(job, b);
    } catch (e) { log(`Falha ao consultar ${job}: ${e.message}`); }
  }
}

async function triggerBuild(job, params) {
  const path = `/${jobPath(job)}/${params && Object.keys(params).length ? 'buildWithParameters' : 'build'}`;
  const body = params ? new URLSearchParams(params) : undefined;
  await jenkinsRaw(path, { method: 'POST', body });
  setTimeout(discover, 4000); // o build entra na fila e começa alguns segundos depois
}
const stopBuild = (job, build) => jenkinsRaw(`/${jobPath(job)}/${build}/stop`, { method: 'POST' });

/* ------------------------------------------------------------------ */
/* Jira                                                                */
/* ------------------------------------------------------------------ */
const jiraReady = () => CFG.jira.url && CFG.jira.email && CFG.jira.token && CFG.jira.project;

async function jira(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${CFG.jira.url}/rest/api/${CFG.jira.version}${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + b64(`${CFG.jira.email}:${CFG.jira.token}`),
      Accept: 'application/json', 'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}
// Jira Cloud (v3) usa Atlassian Document Format; Server/Data Center (v2) aceita texto
const adf = text => ({ type: 'doc', version: 1, content: text.split('\n').map(l => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })) });
const rich = text => (CFG.jira.version === '3' ? adf(text) : text);

async function findOpenBug(term) {
  const jql = `project = "${CFG.jira.project}" AND summary ~ "\\"${term.replace(/"/g, '')}\\"" AND statusCategory != Done ORDER BY created DESC`;
  const q = `jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`;
  const d = await jira(CFG.jira.version === '3' ? `/search/jql?${q}` : `/search?${q}`);
  return d.issues?.[0] || null;
}

async function reportBug({ job, build, scenario, buildUrl, details = '' }) {
  const term = scenario.match(/CT-\d+/)?.[0] || scenario;
  const text = `Falha no cenário: ${scenario}\nPipeline: ${job} (build #${build})\nBuild: ${buildUrl || '-'}\n${details}`.trim();
  const existing = await findOpenBug(term);
  if (existing) {
    await jira(`/issue/${existing.key}/comment`, { method: 'POST', body: { body: rich(text) } });
    emit('jira', { job, build, scenario, key: existing.key, action: 'comment', url: `${CFG.jira.url}/browse/${existing.key}` });
    return { key: existing.key, action: 'comment' };
  }
  const created = await jira('/issue', {
    method: 'POST',
    body: { fields: { project: { key: CFG.jira.project }, issuetype: { name: CFG.jira.issueType }, summary: `[QA] ${job} – ${scenario}`, description: rich(text), labels: CFG.jira.labels } },
  });
  emit('jira', { job, build, scenario, key: created.key, action: 'create', url: `${CFG.jira.url}/browse/${created.key}` });
  return { key: created.key, action: 'create' };
}

// Cenários de teste lidos do Jira pela API de busca (JQL), com paginação.
// field: campo que indica o componente/pipeline (components, labels ou customfield_xxxxx).
async function jiraScenarios({ jql = CFG.jira.scenarioJql, field = CFG.jira.pipelineField, max = 1000 } = {}) {
  const fields = ['summary', 'status', 'components', 'labels', 'updated', field].filter((v, i, a) => v && a.indexOf(v) === i).join(',');
  const out = [];
  let startAt = 0, token = null;
  for (;;) {
    const q = new URLSearchParams({ jql, fields, maxResults: '100' });
    if (CFG.jira.version === '3') { if (token) q.set('nextPageToken', token); }
    else q.set('startAt', String(startAt));
    const d = await jira(`${CFG.jira.version === '3' ? '/search/jql' : '/search'}?${q}`);
    for (const it of d.issues || []) {
      const f = it.fields || {};
      const v = f[field];
      const pipeline = Array.isArray(v) ? (v[0]?.name ?? v[0]?.value ?? v[0] ?? '') : (v?.value ?? v?.name ?? v ?? '');
      out.push({ key: it.key, name: f.summary || it.key, status: f.status?.name || '', pipeline: String(pipeline || ''), updated: f.updated, url: `${CFG.jira.url}/browse/${it.key}` });
    }
    if (out.length >= max) break;
    if (CFG.jira.version === '3') { if (!d.nextPageToken || d.isLast) break; token = d.nextPageToken; }
    else { startAt += (d.issues || []).length; if (!d.issues?.length || startAt >= (d.total || 0)) break; }
  }
  return out.slice(0, max);
}

const DEMO_SCENARIOS = [
  ['QA-101', 'CT-001 Fluxo de compra completo', 'Checkout'], ['QA-102', 'CT-002 Aplicar cupom de desconto', 'Checkout'],
  ['QA-103', 'CT-003 Pagamento com cartão inválido', 'Pagamento'], ['QA-104', 'CT-004 Timeout na API de pagamento', 'Pagamento'],
  ['QA-105', 'CT-005 Validação de carrinho vazio', 'Checkout'], ['QA-130', 'CT-030 Login no app', 'App do Cliente'],
].map(([key, name, pipeline]) => ({ key, name, status: 'Pronto', pipeline, url: '' }));

/* ------------------------------------------------------------------ */
/* Modo demonstração (sem Jenkins)                                     */
/* ------------------------------------------------------------------ */
function startDemo() {
  const jobs = {
    'Checkout': ['CT-001 Fluxo de compra completo', 'CT-002 Aplicar cupom de desconto', 'CT-003 Pagamento com cartão inválido', 'CT-004 Timeout na API de pagamento', 'CT-005 Validação de carrinho vazio', 'CT-006 Calcular frete por CEP'],
    'Pagamento': ['CT-007 Pagar com Pix', 'CT-008 Estorno parcial', 'CT-020 Autorizar cartão', 'CT-021 Capturar pagamento', 'CT-022 Webhook do gateway'],
    'App do Cliente': ['CT-030 Login no app', 'CT-031 Listar pedidos', 'CT-032 Rastrear entrega', 'CT-033 Notificação de status'],
  };
  let n = 5000;
  const running = new Set();
  async function run(job) {
    running.add(job);
    const build = ++n, start = Date.now(), names = jobs[job];
    emit('build_start', { job, build, timestamp: start, estimatedDuration: names.length * 4000, scenarios: names, total: names.length });
    let passed = 0;
    for (const name of names) {
      emit('scenario', { job, build, name, status: 'run', duration: 0, elapsed: Math.round((Date.now() - start) / 1000) });
      const dur = 1500 + Math.random() * 3000;
      await sleep(dur);
      const fail = /Timeout|Estorno/.test(name) ? Math.random() < 0.5 : Math.random() < 0.05;
      if (!fail) passed++;
      emit('scenario', { job, build, name, status: fail ? 'fail' : 'pass', duration: +(dur / 1000).toFixed(2), resp: fail && /Timeout/.test(name) ? 30000 : Math.round(120 + Math.random() * 700), elapsed: Math.round((Date.now() - start) / 1000) });
    }
    emit('build_end', { job, build, status: passed === names.length ? 'Sucesso' : 'Falha', duration: Date.now() - start, passed, failed: names.length - passed, total: names.length });
    running.delete(job);
  }
  setInterval(() => {
    const free = Object.keys(jobs).filter(j => !running.has(j));
    if (running.size < 2 && free.length) run(free[Math.floor(Math.random() * free.length)]);
  }, 3000);
  log('Modo demonstração ativo: gerando execuções fictícias.');
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': CFG.cors });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e6) throw new Error('Corpo muito grande'); }
  return raw ? JSON.parse(raw) : {};
}
const authorized = (req, url) => !CFG.apiKey || req.headers['x-api-key'] === CFG.apiKey || url.searchParams.get('key') === CFG.apiKey;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': CFG.cors, 'Access-Control-Allow-Headers': 'Content-Type, x-api-key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return res.end();
  }
  if (url.pathname === '/api/health') {
    return send(res, 200, { ok: true, demo: CFG.demo, jenkins: !!CFG.jenkins.url, jobs: CFG.jenkins.jobs, jira: !!jiraReady(), clients: clients.size, active: active.size });
  }
  if (!authorized(req, url)) return send(res, 401, { error: 'API key inválida' });

  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': CFG.cors });
      res.write('retry: 3000\n\n');
      for (const m of recent) res.write(m);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, [...active.values()].map(s => ({ job: s.job, build: s.build, start: s.start, scenarios: Object.fromEntries(s.scen), stages: s.stages })));
    }
    if (req.method === 'POST' && url.pathname === '/api/build') {
      const { job, params } = await readJson(req);
      if (!job) return send(res, 400, { error: 'Informe "job"' });
      if (CFG.demo) return send(res, 202, { ok: true, demo: true });
      await triggerBuild(job, params);
      return send(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const { job, build } = await readJson(req);
      if (!job || !build) return send(res, 400, { error: 'Informe "job" e "build"' });
      if (!CFG.demo) await stopBuild(job, build);
      return send(res, 202, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/jira/scenarios') {
      if (CFG.demo && !jiraReady()) return send(res, 200, { demo: true, scenarios: DEMO_SCENARIOS });
      if (!jiraReady()) return send(res, 400, { error: 'Jira não configurado no servidor' });
      const scenarios = await jiraScenarios({
        jql: url.searchParams.get('jql') || undefined,
        field: url.searchParams.get('field') || undefined,
      });
      return send(res, 200, { scenarios });
    }
    if (req.method === 'POST' && url.pathname === '/api/jira/bug') {
      if (!jiraReady()) return send(res, 400, { error: 'Jira não configurado' });
      const body = await readJson(req);
      if (!body.job || !body.scenario) return send(res, 400, { error: 'Informe "job" e "scenario"' });
      return send(res, 201, await reportBug(body));
    }
    send(res, 404, { error: 'Rota não encontrada' });
  } catch (e) {
    log(`Erro ${req.method} ${url.pathname}: ${e.message}`);
    send(res, 502, { error: e.message });
  }
});

server.listen(CFG.port, () => {
  log(`QA AI Agent — servidor em http://localhost:${CFG.port}`);
  if (CFG.demo) return startDemo();
  if (!CFG.jenkins.url || !CFG.jenkins.jobs.length) {
    log('JENKINS_URL e JENKINS_JOBS não configurados. Use DEMO=true para testar sem Jenkins.');
    return;
  }
  log(`Jenkins: ${CFG.jenkins.url} · jobs: ${CFG.jenkins.jobs.join(', ')} · Jira: ${jiraReady() ? CFG.jira.url : 'desligado'}`);
  discover();
  setInterval(discover, CFG.jenkins.discoverMs);
});
