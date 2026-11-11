// QA AI Agent — servidor de tempo real
// Lê as execuções do Jenkins e do GitHub Actions e integra com o Jira usando somente as APIs REST,
// e envia os eventos para a plataforma via Server-Sent Events (SSE).
// Requer Node.js 20.6+ (fetch nativo e --env-file). Sem dependências externas.

import http from 'node:http';

const env = process.env;
const list = v =>
  (v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

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
  // GitHub Actions: cada workflow é acompanhado como um "job" do Jenkins (job = dono/repositório/arquivo.yml)
  github: {
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    token: env.GITHUB_TOKEN || '',
    // "dono/repo/workflow.yml" acompanha um workflow · "dono/repo" acompanha todos os workflows do repositório
    workflows: list(env.GITHUB_WORKFLOWS),
    pollMs: +(env.GITHUB_POLL_MS || 10000),
    discoverMs: +(env.GITHUB_DISCOVER_MS || 30000),
    // só baixa o log dos jobs cujo nome casa com esta expressão (cada log custa 1 chamada)
    logJobs: env.GITHUB_LOG_JOBS ? new RegExp(env.GITHUB_LOG_JOBS, 'iu') : null,
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
    // basic = usuário/e-mail + token · bearer = token pessoal (PAT) do Jira Data Center
    auth: env.JIRA_AUTH === 'bearer' ? 'bearer' : 'basic',
  },
  // Sincronização periódica do Jira (cenários + ciclos). 0 desliga.
  sync: {
    ms: +(env.JIRA_SYNC_MS ?? 300000),
    fullMs: +(env.JIRA_FULL_SYNC_MS || 6 * 3600000),
    afterBuildMs: +(env.JIRA_AFTER_BUILD_MS ?? 20000),
    gapMs: +(env.JIRA_GAP_MS ?? 200),
    minManualMs: +(env.JIRA_MIN_MANUAL_MS ?? 30000),
  },
  // Ciclos de teste do Zephyr Scale (Server/Data Center), pela API ATM do próprio Jira
  zephyr: {
    on: env.ZEPHYR === 'true',
    api: env.ZEPHYR_API_PATH || '/rest/atm/1.0',
    tql: env.ZEPHYR_TQL || '',
    caseField: env.ZEPHYR_CASE_FIELD || '',
    max: +(env.ZEPHYR_MAX_CYCLES || 100),
    activeDays: +(env.ZEPHYR_ACTIVE_DAYS || 30),
    closed: list(env.ZEPHYR_CLOSED_STATUS || 'Done').map(s => s.toLowerCase()),
    cycleUrl: env.ZEPHYR_CYCLE_URL || '{jira}/secure/Tests.jspa#/testPlayer/{key}',
  },
  // Proteção contra limite de requisições (HTTP 429/503) e quedas passageiras
  http: {
    retries: +(env.HTTP_RETRIES ?? 3),
    backoffMs: +(env.HTTP_BACKOFF_MS || 1000),
    maxWaitMs: +(env.HTTP_MAX_WAIT_MS || 60000),
  },
  track: {
    stagesEvery: Math.max(1, +(env.STAGES_EVERY || 3)),
    maxErrors: +(env.TRACK_MAX_ERRORS || 5),
    maxBuilds: +(env.MAX_TRACKED_BUILDS || 10),
    fastBuilds: 5, // acima disso o intervalo de leitura aumenta
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = s => Buffer.from(s).toString('base64');
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ */
/* HTTP com espera e nova tentativa                                    */
/* ------------------------------------------------------------------ */
// Limitador por serviço: sobe quando recebe 429 e desce aos poucos nas respostas boas.
// O fator multiplica o intervalo de leitura do Jenkins (POLL_MS).
const makeThrottle = () => ({
  factor: 1,
  hit() {
    this.factor = Math.min(8, this.factor * 2);
  },
  ok() {
    if (this.factor > 1) this.factor = Math.max(1, this.factor * 0.95);
  },
});
const jenkinsThrottle = makeThrottle();
const jiraThrottle = makeThrottle();
const githubThrottle = makeThrottle();

const TRANSIENT = new Set([429, 502, 503, 504]);
// O GitHub avisa o limite com 403 (ou 429) + x-ratelimit-remaining: 0 (limite primário) ou Retry-After
// (limite secundário). Um 403 comum (sem permissão) não tem esses cabeçalhos e continua sendo erro.
const rateLimited = res =>
  !!res &&
  (res.status === 403 || res.status === 429) &&
  (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
// Retry-After pode vir em segundos ou como data; no limite primário do GitHub vale o x-ratelimit-reset
function retryAfterMs(headers) {
  const v = headers?.get('retry-after');
  if (v) {
    const n = Number(v);
    if (!Number.isNaN(n)) return n * 1000;
    const d = Date.parse(v);
    return Number.isNaN(d) ? 0 : Math.max(0, d - Date.now());
  }
  const reset = Number(headers?.get('x-ratelimit-reset'));
  return headers?.get('x-ratelimit-remaining') === '0' && reset ? Math.max(0, reset * 1000 - Date.now()) : 0;
}

function httpError(label, res, path) {
  const e = new Error(`${label} ${res.status} em ${path}`);
  e.status = res.status;
  e.limited = rateLimited(res); // limite de requisições: espera e tenta de novo, não é falha do build
  return e;
}

// GET repete em 429/502/503/504, no limite do GitHub e em erro de rede. POST repete só quando o
// servidor recusou por limite (429 ou limite do GitHub): a ação não foi executada, então não duplica.
async function fetchRetry(label, url, opts = {}, throttle = null) {
  const safe = !opts.method || opts.method === 'GET';
  for (let i = 0; ; i++) {
    let res = null,
      err = null;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      err = e;
    }
    const limited = rateLimited(res);
    const transient = err ? safe : (TRANSIENT.has(res.status) || limited) && (safe || res.status === 429 || limited);
    if (res && !transient) throttle?.ok();
    if (!transient || i >= CFG.http.retries) {
      if (err) throw err;
      return res;
    }
    const given = retryAfterMs(res?.headers);
    // o limite só volta daqui a muito tempo (ex.: reset do GitHub em 40 min): não adianta insistir agora
    if (limited && given > CFG.http.maxWaitMs) {
      throttle?.hit();
      return res;
    }
    const backoff = CFG.http.backoffMs * 2 ** i * (0.8 + Math.random() * 0.4);
    const wait = Math.min(CFG.http.maxWaitMs, Math.max(given, backoff));
    if (res?.status === 429) throttle?.hit();
    log(
      `${label}: ${res?.status ?? err.message}; nova tentativa ${i + 1}/${CFG.http.retries} em ${Math.round(wait)} ms`
    );
    await sleep(wait);
  }
}
// Erro passageiro (limite, queda de rede, 5xx): não deve virar "Falha" do build
const isTransient = e => e.status === undefined || e.status === 429 || e.status >= 500 || e.limited === true;

/* ------------------------------------------------------------------ */
/* Eventos (SSE)                                                       */
/* ------------------------------------------------------------------ */
const clients = new Set();
const recent = []; // últimos eventos, reenviados a quem conecta
const MAX_RECENT = 300;

// keep=false: evento só para quem está conectado (não entra no reenvio dos últimos eventos)
function emit(type, data, keep = true) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  if (keep) {
    recent.push(msg);
    if (recent.length > MAX_RECENT) recent.shift();
  }
  for (const res of clients) res.write(msg);
}

/* ------------------------------------------------------------------ */
/* Jenkins                                                             */
/* ------------------------------------------------------------------ */
const jobPath = job =>
  job
    .split('/')
    .map(s => 'job/' + encodeURIComponent(s))
    .join('/');
const jenkinsHeaders = () => ({ Authorization: 'Basic ' + b64(`${CFG.jenkins.user}:${CFG.jenkins.token}`) });

async function jenkinsRaw(path, opts = {}) {
  const res = await fetchRetry(
    'Jenkins',
    CFG.jenkins.url + path,
    { ...opts, headers: { ...jenkinsHeaders(), ...(opts.headers || {}) } },
    jenkinsThrottle
  );
  if (!res.ok) throw httpError('Jenkins', res, path);
  return res;
}
const jenkinsJson = async path => (await jenkinsRaw(path)).json();

// Formatos reconhecidos por padrão (Playwright "list", Cypress/Mocha "spec", Jest, TAP):
//   ✓  3 [chromium] › checkout.spec.ts:12:5 › CT-001 Fluxo de compra completo (1.2s)
//   ✘  4 [chromium] › checkout.spec.ts:30:5 › CT-004 Timeout na API de pagamento (30.0s)
//   ✓ CT-002 Aplicar cupom de desconto (842ms)
const DEFAULT_LINE =
  /^\s*(?<status>✓|✔|√|✗|✘|×|✕)\s+(?:\d+\s+)?(?<name>.+?)\s*\((?<dur>\d+(?:[.,]\d+)?)\s*(?<unit>ms|s|m)\)\s*$/u;
const PASS = new Set(['✓', '✔', '√', 'ok', 'OK', 'pass', 'passed', 'PASS', 'PASSED', 'Passed', 'SUCCESS']);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

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
    // remove cores e o carimbo de hora que o GitHub Actions põe no início de cada linha do log
    const line = raw.replace(ANSI, '').replace(STAMP, '');
    const r = line.match(CFG.jenkins.respRegex);
    if (r?.groups) {
      st.resp.set(cleanName(r.groups.name), +r.groups.ms);
      continue;
    }
    const m = line.match(re);
    if (!m?.groups) continue;
    const name = cleanName(m.groups.name);
    const status = PASS.has(m.groups.status) ? 'pass' : 'fail';
    const duration = m.groups.dur ? +toSeconds(m.groups.dur, m.groups.unit || 's').toFixed(2) : 0;
    st.scen.set(name, status);
    emit('scenario', {
      job: st.job,
      build: st.build,
      name,
      status,
      duration,
      resp: respFor(st, name),
      elapsed: Math.round((Date.now() - st.start) / 1000),
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

// Intervalo de leitura do log: cresce com o número de builds acompanhados e quando o Jenkins pede calma (429)
const pollWait = () =>
  CFG.jenkins.pollMs * jenkinsThrottle.factor * Math.max(1, Math.ceil(active.size / CFG.track.fastBuilds));

async function track(job, b) {
  const key = `${job}#${b.number}`;
  const st = {
    job,
    build: b.number,
    offset: 0,
    buf: '',
    start: b.timestamp || Date.now(),
    scen: new Map(),
    resp: new Map(),
    stages: {},
  };
  active.set(key, st);
  log(`Acompanhando ${key}`);
  emit('build_start', {
    job,
    build: b.number,
    timestamp: st.start,
    estimatedDuration: b.estimatedDuration,
    folder: job.includes('/') ? job.split('/').slice(0, -1).join('/') : undefined,
    url: `${CFG.jenkins.url}/${jobPath(job)}/${b.number}/`,
  });
  try {
    let more = true,
      loops = 0,
      errors = 0;
    while (more) {
      try {
        const res = await jenkinsRaw(`/${jobPath(job)}/${b.number}/logText/progressiveText?start=${st.offset}`);
        const text = await res.text();
        st.offset = +(res.headers.get('x-text-size') || st.offset);
        more = res.headers.get('x-more-data') === 'true';
        parseLines(st, text, !more);
        // estágios: na 1ª leitura, a cada N leituras e na última (economiza ~1/3 das chamadas)
        if (loops++ % CFG.track.stagesEvery === 0 || !more) await pollStages(st);
        errors = 0;
      } catch (e) {
        // erro passageiro: espera e tenta de novo, sem marcar o build como falha
        if (!isTransient(e) || ++errors > CFG.track.maxErrors) throw e;
        log(`${key}: ${e.message}; leitura ${errors}/${CFG.track.maxErrors} adiada`);
      }
      if (more) await sleep(pollWait());
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
  // sem resultado (erro passageiro) não dá para saber se passou: tenta de novo antes de concluir
  let info = {};
  for (let i = 0; i < 3 && !info.result; i++) {
    info = await jenkinsJson(`${base}/api/json?tree=result,duration`).catch(() => ({}));
    if (!info.result && i < 2) await sleep(pollWait());
  }
  let tr = null;
  try {
    tr = await jenkinsJson(`${base}/testReport/api/json?tree=passCount,failCount,skipCount`);
  } catch {
    /* sem relatório JUnit */
  }
  const fromLog = [...st.scen.values()];
  const passed = tr?.passCount ?? fromLog.filter(s => s === 'pass').length;
  const failed = tr?.failCount ?? fromLog.filter(s => s === 'fail').length;
  const total = passed + failed + (tr?.skipCount || 0);
  const status =
    info.result === 'ABORTED' ? 'Cancelada' : info.result === 'SUCCESS' && failed === 0 ? 'Sucesso' : 'Falha';
  emit('build_end', {
    job: st.job,
    build: st.build,
    status,
    duration: info.duration || Date.now() - st.start,
    passed,
    failed,
    total,
    result: info.result,
  });
  log(`${st.job}#${st.build} finalizado: ${status} (${passed}/${total})`);
  await afterBuild(st, `${CFG.jenkins.url}${base}/`);
}

// Depois de qualquer build (Jenkins ou GitHub Actions): atualiza os ciclos e abre bugs das falhas
async function afterBuild(st, buildUrl) {
  syncSoon();
  if (CFG.jira.autoBug && jiraReady()) {
    for (const [name, s] of st.scen) {
      if (s !== 'fail') continue;
      await reportBug({ job: st.job, build: st.build, scenario: name, buildUrl }).catch(e => log(`Jira: ${e.message}`));
    }
  }
}

async function discover() {
  for (const job of CFG.jenkins.jobs) {
    try {
      const d = await jenkinsJson(
        `/${jobPath(job)}/api/json?tree=builds[number,building,timestamp,estimatedDuration]{0,5}`
      );
      for (const b of d.builds || []) {
        if (!b.building || active.has(`${job}#${b.number}`)) continue;
        if (active.size >= CFG.track.maxBuilds) {
          log(`Limite de ${CFG.track.maxBuilds} builds acompanhados: ${job}#${b.number} fica para a próxima rodada`);
          continue;
        }
        track(job, b);
      }
    } catch (e) {
      log(`Falha ao consultar ${job}: ${e.message}`);
    }
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
/* GitHub Actions                                                      */
/* ------------------------------------------------------------------ */
// Mesmo processo do Jenkins, adaptado ao que a API do GitHub oferece:
//   workflow  = job do Jenkins         (job = "dono/repo/arquivo.yml", pasta = "dono/repo")
//   run       = build                  (build = run_number)
//   job do workflow = estágio          (evento "stage")
//   cenários  = linhas do log de cada job, lidas quando o job termina. O GitHub só libera o log de
//               um job concluído, então os cenários chegam por job e não linha a linha.
// Custo: respostas 304 (ETag) não contam no limite de 5.000 chamadas/hora do token.
const ghReady = () => !!(CFG.github.token && CFG.github.workflows.length);
const ghHeaders = () => ({
  Authorization: `Bearer ${CFG.github.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});
// limite informado pelo GitHub na última resposta
const ghRate = { limit: null, remaining: null, reset: 0 };
const ghEtags = new Map(); // caminho → { etag, body }

// "dono/repo/arquivo.yml" → { repo, file } se o job pertence a um workflow configurado; senão null
function ghParse(job) {
  const m = String(job).match(/^([^/]+\/[^/]+)\/([^/]+\.ya?ml)$/i);
  if (!m) return null;
  const low = x => x.toLowerCase();
  return CFG.github.workflows.some(w => low(w) === low(m[1]) || low(w) === low(job))
    ? { repo: m[1], file: m[2] }
    : null;
}

function ghGuard() {
  if (ghRate.remaining === 0 && ghRate.reset * 1000 > Date.now()) {
    const e = new Error(`GitHub: limite de chamadas esgotado até ${new Date(ghRate.reset * 1000).toISOString()}`);
    e.limited = true;
    throw e;
  }
}

async function ghRaw(path, opts = {}) {
  ghGuard();
  const res = await fetchRetry(
    'GitHub',
    CFG.github.api + path,
    { ...opts, headers: { ...ghHeaders(), ...(opts.headers || {}) } },
    githubThrottle
  );
  const h = res.headers;
  if (h.get('x-ratelimit-remaining') !== null) {
    ghRate.limit = +h.get('x-ratelimit-limit') || ghRate.limit;
    ghRate.remaining = +h.get('x-ratelimit-remaining');
    ghRate.reset = +h.get('x-ratelimit-reset') || 0;
  }
  if (!res.ok && res.status !== 304) throw httpError('GitHub', res, path);
  return res;
}

// GET com ETag: se nada mudou o GitHub responde 304, que não consome o limite
async function ghJson(path) {
  const hit = ghEtags.get(path);
  const res = await ghRaw(path, hit ? { headers: { 'If-None-Match': hit.etag } } : {});
  if (res.status === 304 && hit) return hit.body;
  const body = await res.json();
  const etag = res.headers.get('etag');
  if (etag) {
    if (ghEtags.size >= 500) ghEtags.delete(ghEtags.keys().next().value);
    ghEtags.set(path, { etag, body });
  }
  return body;
}

// Espera entre leituras de um run: cresce quando o GitHub pede calma e quando o limite está acabando
function ghWait() {
  const low = ghRate.remaining !== null && ghRate.remaining < 200 ? 4 : 1;
  const base =
    CFG.github.pollMs * githubThrottle.factor * low * Math.max(1, Math.ceil(active.size / CFG.track.fastBuilds));
  const untilReset = ghRate.remaining === 0 ? Math.min(300000, Math.max(0, ghRate.reset * 1000 - Date.now())) : 0;
  return Math.max(base, untilReset);
}

// Estado do job do GitHub → status de estágio no formato que a tela já conhece (o mesmo do Jenkins)
function ghStage(j) {
  if (j.status !== 'completed') return 'IN_PROGRESS';
  return (
    {
      success: 'SUCCESS',
      neutral: 'SUCCESS',
      cancelled: 'ABORTED',
      skipped: 'NOT_EXECUTED',
      action_required: 'PAUSED_PENDING_INPUT',
    }[j.conclusion] || 'FAILED'
  );
}
const ghFile = run =>
  String(run.path || '')
    .split('/')
    .pop()
    .split('@')[0] || String(run.workflow_id);

// Lê o log de um job concluído e transforma as linhas de resultado em eventos "scenario"
async function ghJobLog(st, j) {
  if (j.conclusion === 'skipped' || (CFG.github.logJobs && !CFG.github.logJobs.test(j.name))) return;
  try {
    const res = await ghRaw(`/repos/${st.repo}/actions/jobs/${j.id}/logs`);
    parseLines(st, await res.text(), true);
  } catch (e) {
    if (isTransient(e)) throw e; // tenta de novo na próxima leitura
    log(`${st.job}#${st.build}: log do job "${j.name}" indisponível (${e.message})`); // expirado ou sem permissão
  }
}

async function ghTrack(repo, run) {
  const file = ghFile(run),
    job = `${repo}/${file}`,
    key = `${job}#${run.run_number}`;
  const st = {
    src: 'github',
    job,
    repo,
    runId: run.id,
    build: run.run_number,
    buf: '',
    start: Date.parse(run.run_started_at || run.created_at) || Date.now(),
    scen: new Map(),
    resp: new Map(),
    stages: {},
    logged: new Set(),
  };
  active.set(key, st);
  log(`Acompanhando ${key}`);
  emit('build_start', {
    job,
    build: run.run_number,
    timestamp: st.start,
    folder: repo,
    name: run.name || file,
    source: 'GitHub Actions',
    branch: run.head_branch,
    url: run.html_url,
  });
  let r = run,
    errors = 0,
    limits = 0;
  try {
    while (r.status !== 'completed') {
      await sleep(ghWait());
      try {
        // run primeiro e jobs depois: a lista de jobs é sempre igual ou mais nova que o run
        r = await ghJson(`/repos/${repo}/actions/runs/${run.id}`);
        const { jobs = [] } = await ghJson(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
        for (const j of jobs) {
          if (j.status === 'queued' || j.status === 'waiting' || j.status === 'pending') continue;
          const status = ghStage(j);
          if (st.stages[j.name] !== status) {
            st.stages[j.name] = status;
            const end = Date.parse(j.completed_at) || Date.now();
            emit('stage', {
              job,
              build: run.run_number,
              stage: j.name,
              status,
              duration: Math.max(0, end - (Date.parse(j.started_at) || end)),
            });
          }
          if (j.status === 'completed' && !st.logged.has(j.id)) {
            await ghJobLog(st, j);
            st.logged.add(j.id);
          }
        }
        errors = limits = 0;
      } catch (e) {
        // limite ou queda passageira: espera e tenta de novo, sem marcar o run como falha
        if (!isTransient(e)) throw e;
        if (e.limited ? ++limits > 60 : ++errors > CFG.track.maxErrors) throw e;
        log(`${key}: ${e.message}; leitura adiada`);
      }
    }
    await ghFinish(st, r);
  } catch (e) {
    log(`Erro em ${key}: ${e.message}`);
    emit('build_end', { job, build: run.run_number, status: 'Falha', error: e.message, source: 'GitHub Actions' });
  } finally {
    active.delete(key);
  }
}

async function ghFinish(st, r) {
  const scen = [...st.scen.values()];
  const passed = scen.filter(s => s === 'pass').length;
  const failed = scen.filter(s => s === 'fail').length;
  const status =
    r.conclusion === 'cancelled' ? 'Cancelada' : r.conclusion === 'success' && failed === 0 ? 'Sucesso' : 'Falha';
  const end = Date.parse(r.updated_at) || Date.now();
  emit('build_end', {
    job: st.job,
    build: st.build,
    status,
    duration: Math.max(0, end - st.start),
    passed,
    failed,
    total: passed + failed,
    result: String(r.conclusion || '').toUpperCase(),
    source: 'GitHub Actions',
  });
  log(`${st.job}#${st.build} finalizado: ${status} (${passed}/${passed + failed})`);
  await afterBuild(st, r.html_url);
}

// Procura runs em andamento: 1 chamada por workflow (ou por repositório) a cada GITHUB_DISCOVER_MS
async function ghDiscover() {
  for (const w of CFG.github.workflows) {
    const parts = w.split('/');
    const repo = parts.slice(0, 2).join('/'),
      file = parts[2];
    try {
      const d = await ghJson(
        file
          ? `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=5`
          : `/repos/${repo}/actions/runs?per_page=10`
      );
      for (const run of d.workflow_runs || []) {
        if (run.status === 'completed') continue;
        const key = `${repo}/${ghFile(run)}#${run.run_number}`;
        if (active.has(key)) continue;
        if (active.size >= CFG.track.maxBuilds) {
          log(`Limite de ${CFG.track.maxBuilds} builds acompanhados: ${key} fica para a próxima rodada`);
          continue;
        }
        ghTrack(repo, run);
      }
    } catch (e) {
      log(`Falha ao consultar ${w}: ${e.message}`);
    }
  }
}

// Dispara o workflow (precisa de "on: workflow_dispatch"). Sem "ref", usa a branch padrão do repositório.
async function ghTrigger(job, params = {}) {
  const { repo, file } = ghParse(job);
  const { ref, ...inputs } = params;
  const branch = ref || (await ghJson(`/repos/${repo}`)).default_branch;
  await ghRaw(`/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: branch, ...(Object.keys(inputs).length ? { inputs } : {}) }),
  });
  setTimeout(ghDiscover, 6000); // o run aparece alguns segundos depois do disparo
}
async function ghStop(job, build) {
  const st = active.get(`${job}#${build}`);
  if (!st?.runId) throw new Error('Run não está em acompanhamento');
  await ghRaw(`/repos/${st.repo}/actions/runs/${st.runId}/cancel`, { method: 'POST' });
}

/* ------------------------------------------------------------------ */
/* Jira                                                                */
/* ------------------------------------------------------------------ */
const jiraReady = () =>
  CFG.jira.url && CFG.jira.token && CFG.jira.project && (CFG.jira.auth === 'bearer' || CFG.jira.email);

const jiraHeaders = () => ({
  Authorization:
    CFG.jira.auth === 'bearer' ? `Bearer ${CFG.jira.token}` : 'Basic ' + b64(`${CFG.jira.email}:${CFG.jira.token}`),
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

async function jira(path, { method = 'GET', body } = {}) {
  const res = await fetchRetry(
    'Jira',
    `${CFG.jira.url}/rest/api/${CFG.jira.version}${path}`,
    { method, headers: jiraHeaders(), body: body && JSON.stringify(body) },
    jiraThrottle
  );
  if (!res.ok) {
    const e = new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}
// Jira Cloud (v3) usa Atlassian Document Format; Server/Data Center (v2) aceita texto
const adf = text => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').map(l => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })),
});
const rich = text => (CFG.jira.version === '3' ? adf(text) : text);

async function findOpenBug(term) {
  const jql = `project = "${CFG.jira.project}" AND summary ~ "\\"${term.replace(/"/g, '')}\\"" AND statusCategory != Done ORDER BY created DESC`;
  const q = `jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`;
  const d = await jira(CFG.jira.version === '3' ? `/search/jql?${q}` : `/search?${q}`);
  return d.issues?.[0] || null;
}

async function reportBug({ job, build, scenario, buildUrl, details = '' }) {
  const term = scenario.match(/CT-\d+/)?.[0] || scenario;
  const text =
    `Falha no cenário: ${scenario}\nPipeline: ${job} (build #${build})\nBuild: ${buildUrl || '-'}\n${details}`.trim();
  const existing = await findOpenBug(term);
  if (existing) {
    await jira(`/issue/${existing.key}/comment`, { method: 'POST', body: { body: rich(text) } });
    emit('jira', {
      job,
      build,
      scenario,
      key: existing.key,
      action: 'comment',
      url: `${CFG.jira.url}/browse/${existing.key}`,
    });
    return { key: existing.key, action: 'comment' };
  }
  const created = await jira('/issue', {
    method: 'POST',
    body: {
      fields: {
        project: { key: CFG.jira.project },
        issuetype: { name: CFG.jira.issueType },
        summary: `[QA] ${job} – ${scenario}`,
        description: rich(text),
        labels: CFG.jira.labels,
      },
    },
  });
  emit('jira', {
    job,
    build,
    scenario,
    key: created.key,
    action: 'create',
    url: `${CFG.jira.url}/browse/${created.key}`,
  });
  return { key: created.key, action: 'create' };
}

// Cenários de teste lidos do Jira pela API de busca (JQL), com paginação.
// field: campo que indica o componente/pipeline (components, labels ou customfield_xxxxx).
// Chave do caso de teste do Zephyr (PROJ-T123) guardada na issue do cenário: no campo
// ZEPHYR_CASE_FIELD, se existir, ou então no título e nos labels.
const CASE_KEY = /\b[A-Z][A-Z0-9_]+-T\d+\b/;
function caseKeyOf(f) {
  const own = CFG.zephyr.caseField ? JSON.stringify(f[CFG.zephyr.caseField] ?? '') : '';
  return (own.match(CASE_KEY) ||
    (f.summary || '').match(CASE_KEY) ||
    (f.labels || []).join(' ').match(CASE_KEY) || [''])[0];
}

async function jiraScenarios({ jql = CFG.jira.scenarioJql, field = CFG.jira.pipelineField, max = 1000 } = {}) {
  const fields = ['summary', 'status', 'components', 'labels', 'updated', field, CFG.zephyr.caseField]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join(',');
  const out = [];
  let startAt = 0,
    token = null;
  for (;;) {
    const q = new URLSearchParams({ jql, fields, maxResults: '100' });
    if (CFG.jira.version === '3') {
      if (token) q.set('nextPageToken', token);
    } else q.set('startAt', String(startAt));
    const d = await jira(`${CFG.jira.version === '3' ? '/search/jql' : '/search'}?${q}`);
    for (const it of d.issues || []) {
      const f = it.fields || {};
      const v = f[field];
      const pipeline = Array.isArray(v) ? (v[0]?.name ?? v[0]?.value ?? v[0] ?? '') : (v?.value ?? v?.name ?? v ?? '');
      out.push({
        key: it.key,
        name: f.summary || it.key,
        status: f.status?.name || '',
        pipeline: String(pipeline || ''),
        caseKey: caseKeyOf(f),
        updated: f.updated,
        url: `${CFG.jira.url}/browse/${it.key}`,
      });
    }
    if (out.length >= max) break;
    if (CFG.jira.version === '3') {
      if (!d.nextPageToken || d.isLast) break;
      token = d.nextPageToken;
    } else {
      startAt += (d.issues || []).length;
      if (!d.issues?.length || startAt >= (d.total || 0)) break;
    }
  }
  return out.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Zephyr Scale (Server/Data Center): ciclos de teste                  */
/* ------------------------------------------------------------------ */
// Os casos de teste do Zephyr NÃO são issues do Jira; os ciclos se chamam "testrun" na API ATM.
// Os caminhos abaixo seguem a API ATM do Zephyr Scale Server/DC e devem ser confirmados no seu
// ambiente (ver docs/CONTRATOS.md). Autenticação: a mesma do Jira.
const txt = v => (v && typeof v === 'object' ? (v.name ?? v.value ?? '') : (v ?? ''));
const cycleUrl = key => CFG.zephyr.cycleUrl.replace('{jira}', CFG.jira.url).replace('{key}', encodeURIComponent(key));

async function zephyrJson(path, params) {
  const q = params ? '?' + new URLSearchParams(params) : '';
  const res = await fetchRetry(
    'Zephyr',
    `${CFG.jira.url}${CFG.zephyr.api}${path}${q}`,
    { headers: jiraHeaders() },
    jiraThrottle
  );
  if (!res.ok) throw httpError('Zephyr', res, path);
  return res.json();
}

// Status do Zephyr (Pass, Fail, Blocked, In Progress, Not Executed) → pass | fail | blocked | run | pend
function caseStatus(s) {
  const t = String(txt(s)).toLowerCase();
  if (/not|n[aã]o|unexec/.test(t)) return 'pend';
  if (/pass|aprov/.test(t)) return 'pass';
  if (/fail|reprov|falh/.test(t)) return 'fail';
  if (/block|bloque/.test(t)) return 'blocked';
  if (/progress|andamento/.test(t)) return 'run';
  return 'pend';
}

// Lista os ciclos (sem os itens), do mais recente para o mais antigo
async function zephyrList() {
  const tql = CFG.zephyr.tql || `projectKey = "${CFG.jira.project}"`;
  const seen = new Map();
  for (let startAt = 0; seen.size < CFG.zephyr.max; ) {
    const d = await zephyrJson('/testrun/search', {
      query: tql,
      fields: 'key,name,status,folder,updatedOn,plannedStartDate,plannedEndDate',
      startAt,
      maxResults: 100,
    });
    const rows = Array.isArray(d) ? d : d.results || d.values || [];
    const before = seen.size;
    for (const r of rows) if (r.key) seen.set(r.key, r);
    if (rows.length < 100 || seen.size === before) break; // fim, ou a API ignorou a paginação
    startAt += rows.length;
    await sleep(CFG.sync.gapMs);
  }
  return [...seen.values()]
    .map(r => ({
      key: r.key,
      name: r.name || r.key,
      status: String(txt(r.status)),
      folder: String(txt(r.folder)),
      updated: r.updatedOn || '',
      start: r.plannedStartDate || '',
      end: r.plannedEndDate || '',
    }))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, CFG.zephyr.max);
}

// Itens (casos) de um ciclo e o resultado de cada um
async function zephyrItems(key) {
  const d = await zephyrJson(`/testrun/${encodeURIComponent(key)}`);
  return (d.items || [])
    .map(i => ({ case: i.testCaseKey || i.testCase?.key || '', status: caseStatus(i.status) }))
    .filter(i => i.case);
}

/* ------------------------------------------------------------------ */
/* Sincronização periódica do Jira (cache no servidor)                 */
/* ------------------------------------------------------------------ */
// A tela lê sempre deste cache: não importa quantas pessoas abrem a plataforma, o Jira recebe
// as mesmas poucas chamadas a cada JIRA_SYNC_MS.
const jcache = {
  syncedAt: 0,
  scenAt: 0,
  fullAt: 0,
  scenarios: new Map(),
  cycles: new Map(),
  error: null,
  running: false,
  again: false,
};

// Acrescenta "updated >= -Nm" (tempo relativo: não depende do fuso do Jira) antes do ORDER BY
function onlyUpdated(jql, mins) {
  const m = jql.match(/^(.*?)(\s+order\s+by\s+.*)?$/is);
  const base = m[1].trim();
  return `${base ? `(${base}) AND ` : ''}updated >= -${mins}m${m[2] || ''}`;
}
// Ciclo "ativo" = não encerrado e atualizado recentemente: só esses são relidos a cada rodada
const isActive = c =>
  !CFG.zephyr.closed.includes(c.status.toLowerCase()) &&
  !(Date.parse(c.updated) < Date.now() - CFG.zephyr.activeDays * 86400000);

async function syncCycles(openOnly, changed) {
  let list;
  if (openOnly) list = [...jcache.cycles.values()].map(c => c.meta);
  else {
    list = await zephyrList();
    const keep = new Set(list.map(c => c.key));
    for (const k of [...jcache.cycles.keys()])
      if (!keep.has(k)) {
        jcache.cycles.delete(k);
        changed.push(k);
      }
  }
  for (const meta of list) {
    const old = jcache.cycles.get(meta.key);
    if (openOnly && !isActive(meta)) continue;
    if (!openOnly && old && !isActive(meta) && old.meta.updated === meta.updated) {
      old.meta = meta; // encerrado e sem mudança: não precisa reler os itens
      continue;
    }
    let items;
    try {
      items = await zephyrItems(meta.key);
    } catch (e) {
      if (isTransient(e)) throw e; // limite ou queda: interrompe a rodada em vez de insistir
      log(`Zephyr: ciclo ${meta.key} ignorado (${e.message})`);
      continue;
    }
    const sig = items.map(i => i.case + i.status).join('|');
    if (!old || old.sig !== sig || old.meta.status !== meta.status) changed.push(meta.key);
    jcache.cycles.set(meta.key, { meta, items, sig });
    await sleep(CFG.sync.gapMs);
  }
}

// full: relê todos os cenários · openOnly: só os itens dos ciclos ativos (usado após cada build)
async function syncJira({ full = false, openOnly = false } = {}) {
  if (!jiraReady()) return;
  if (jcache.running) {
    jcache.again = true;
    return;
  }
  jcache.running = true;
  const t0 = Date.now(),
    changed = [];
  try {
    if (!openOnly) {
      full = full || !jcache.scenAt || t0 - jcache.fullAt > CFG.sync.fullMs;
      const mins = Math.ceil((t0 - jcache.scenAt) / 60000) + 2;
      const rows = await jiraScenarios({ jql: full ? CFG.jira.scenarioJql : onlyUpdated(CFG.jira.scenarioJql, mins) });
      if (full) {
        const keep = new Set(rows.map(r => r.key));
        for (const k of [...jcache.scenarios.keys()])
          if (!keep.has(k)) {
            jcache.scenarios.delete(k);
            changed.push(k);
          }
        jcache.fullAt = t0;
      }
      for (const r of rows) {
        const old = jcache.scenarios.get(r.key);
        if (!old || old.updated !== r.updated) changed.push(r.key);
        jcache.scenarios.set(r.key, r);
      }
      jcache.scenAt = t0;
    }
    if (CFG.zephyr.on) await syncCycles(openOnly, changed);
    jcache.syncedAt = Date.now();
    jcache.error = null;
    log(`Jira: ${full ? 'completa' : openOnly ? 'ciclos abertos' : 'incremental'} · ${changed.length} alteração(ões)`);
  } catch (e) {
    jcache.error = e.message;
    log(`Jira: falha na sincronização (${e.message}); mantendo os últimos dados`);
  } finally {
    jcache.running = false;
  }
  emit('jira_sync', { at: jcache.syncedAt || null, error: jcache.error, changed: changed.length }, false);
  if (jcache.again) {
    jcache.again = false;
    setTimeout(() => syncJira({ openOnly: true }), 1000);
  }
}

// Depois de cada build, relê só os ciclos ativos (dá tempo do Zephyr receber os resultados)
let afterTimer = null;
function syncSoon() {
  if (!CFG.zephyr.on || !CFG.sync.afterBuildMs || !jiraReady()) return;
  clearTimeout(afterTimer);
  afterTimer = setTimeout(() => syncJira({ openOnly: true }), CFG.sync.afterBuildMs);
}

function startJiraSync() {
  if (!jiraReady() || !CFG.sync.ms) return;
  log(
    `Jira: sincronização a cada ${Math.round(CFG.sync.ms / 1000)} s${CFG.zephyr.on ? ' · ciclos do Zephyr Scale ativos' : ''}`
  );
  syncJira({ full: true });
  setInterval(() => syncJira(), CFG.sync.ms);
}

// Estado entregue à tela: cenários com os ciclos em que aparecem + resumo de cada ciclo
function jiraState() {
  const byCase = new Map();
  for (const s of jcache.scenarios.values()) if (s.caseKey) byCase.set(s.caseKey, s.key);
  const inCycles = new Map();
  const cycles = [...jcache.cycles.values()].map(({ meta, items }) => {
    const totals = { total: items.length, pass: 0, fail: 0, blocked: 0, run: 0, pend: 0, unlinked: 0 };
    for (const i of items) {
      totals[i.status]++;
      const sk = byCase.get(i.case);
      if (!sk) totals.unlinked++;
      else inCycles.set(sk, [...(inCycles.get(sk) || []), { key: meta.key, name: meta.name, status: i.status }]);
    }
    return { ...meta, url: cycleUrl(meta.key), totals };
  });
  return {
    syncedAt: jcache.syncedAt || null,
    error: jcache.error,
    jql: CFG.jira.scenarioJql,
    field: CFG.jira.pipelineField,
    zephyr: CFG.zephyr.on,
    scenarios: [...jcache.scenarios.values()].map(s => ({ ...s, cycles: inCycles.get(s.key) || [] })),
    cycles,
  };
}

const DEMO_SCENARIOS = [
  ['QA-101', 'CT-001 Fluxo de compra completo', 'Checkout'],
  ['QA-102', 'CT-002 Aplicar cupom de desconto', 'Checkout'],
  ['QA-103', 'CT-003 Pagamento com cartão inválido', 'Pagamento'],
  ['QA-104', 'CT-004 Timeout na API de pagamento', 'Pagamento'],
  ['QA-105', 'CT-005 Validação de carrinho vazio', 'Checkout'],
  ['QA-130', 'CT-030 Login no app', 'App do Cliente'],
].map(([key, name, pipeline], i) => ({ key, name, status: 'Pronto', pipeline, caseKey: `QA-T${i + 1}`, url: '' }));

// Dados de exemplo para o modo demonstração (sem Jira)
function seedDemoJira() {
  for (const s of DEMO_SCENARIOS) jcache.scenarios.set(s.key, s);
  const cycle = (key, name, status, st) => {
    const items = DEMO_SCENARIOS.map((s, i) => ({ case: s.caseKey, status: st[i] || 'pend' }));
    jcache.cycles.set(key, {
      meta: { key, name, status, folder: '/Regressão', updated: new Date().toISOString(), start: '', end: '' },
      items,
      sig: '',
    });
  };
  cycle('QA-R1', 'Regressão Sprint 42', 'In Progress', ['pass', 'pass', 'fail', 'fail', 'pend', 'pass']);
  cycle('QA-R2', 'Smoke da release 3.8', 'Done', ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  jcache.syncedAt = Date.now();
}

/* ------------------------------------------------------------------ */
/* Modo demonstração (sem Jenkins)                                     */
/* ------------------------------------------------------------------ */
function startDemo() {
  const jobs = {
    Checkout: [
      'CT-001 Fluxo de compra completo',
      'CT-002 Aplicar cupom de desconto',
      'CT-003 Pagamento com cartão inválido',
      'CT-004 Timeout na API de pagamento',
      'CT-005 Validação de carrinho vazio',
      'CT-006 Calcular frete por CEP',
    ],
    Pagamento: [
      'CT-007 Pagar com Pix',
      'CT-008 Estorno parcial',
      'CT-020 Autorizar cartão',
      'CT-021 Capturar pagamento',
      'CT-022 Webhook do gateway',
    ],
    'App do Cliente': [
      'CT-030 Login no app',
      'CT-031 Listar pedidos',
      'CT-032 Rastrear entrega',
      'CT-033 Notificação de status',
    ],
  };
  let n = 5000;
  const running = new Set();
  async function run(job) {
    running.add(job);
    const build = ++n,
      start = Date.now(),
      names = jobs[job];
    emit('build_start', {
      job,
      build,
      timestamp: start,
      estimatedDuration: names.length * 4000,
      scenarios: names,
      total: names.length,
    });
    let passed = 0;
    for (const name of names) {
      emit('scenario', {
        job,
        build,
        name,
        status: 'run',
        duration: 0,
        elapsed: Math.round((Date.now() - start) / 1000),
      });
      const dur = 1500 + Math.random() * 3000;
      await sleep(dur);
      const fail = /Timeout|Estorno/.test(name) ? Math.random() < 0.5 : Math.random() < 0.05;
      if (!fail) passed++;
      emit('scenario', {
        job,
        build,
        name,
        status: fail ? 'fail' : 'pass',
        duration: +(dur / 1000).toFixed(2),
        resp: fail && /Timeout/.test(name) ? 30000 : Math.round(120 + Math.random() * 700),
        elapsed: Math.round((Date.now() - start) / 1000),
      });
    }
    emit('build_end', {
      job,
      build,
      status: passed === names.length ? 'Sucesso' : 'Falha',
      duration: Date.now() - start,
      passed,
      failed: names.length - passed,
      total: names.length,
    });
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
  for await (const c of req) {
    raw += c;
    if (raw.length > 1e6) throw new Error('Corpo muito grande');
  }
  return raw ? JSON.parse(raw) : {};
}
const authorized = (req, url) =>
  !CFG.apiKey || req.headers['x-api-key'] === CFG.apiKey || url.searchParams.get('key') === CFG.apiKey;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CFG.cors,
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      demo: CFG.demo,
      jenkins: !!CFG.jenkins.url,
      jobs: CFG.jenkins.jobs,
      github: ghReady(),
      workflows: CFG.github.workflows,
      githubRate: { limit: ghRate.limit, remaining: ghRate.remaining, reset: ghRate.reset || null },
      jira: !!jiraReady(),
      zephyr: CFG.zephyr.on,
      jiraSync: { at: jcache.syncedAt || null, error: jcache.error },
      slow: {
        jenkins: +jenkinsThrottle.factor.toFixed(2),
        jira: +jiraThrottle.factor.toFixed(2),
        github: +githubThrottle.factor.toFixed(2),
      },
      clients: clients.size,
      active: active.size,
    });
  }
  if (!authorized(req, url)) return send(res, 401, { error: 'API key inválida' });

  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': CFG.cors,
      });
      res.write('retry: 3000\n\n');
      for (const m of recent) res.write(m);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(
        res,
        200,
        [...active.values()].map(s => ({
          job: s.job,
          build: s.build,
          start: s.start,
          scenarios: Object.fromEntries(s.scen),
          stages: s.stages,
        }))
      );
    }
    if (req.method === 'POST' && url.pathname === '/api/build') {
      const { job, params } = await readJson(req);
      if (!job) return send(res, 400, { error: 'Informe "job"' });
      if (CFG.demo) return send(res, 202, { ok: true, demo: true });
      if (ghParse(job)) await ghTrigger(job, params);
      else await triggerBuild(job, params);
      return send(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const { job, build } = await readJson(req);
      if (!job || !build) return send(res, 400, { error: 'Informe "job" e "build"' });
      if (!CFG.demo) await (ghParse(job) ? ghStop(job, build) : stopBuild(job, build));
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
    // Estado em cache (cenários + ciclos). Não chama o Jira: quem chama é a sincronização periódica.
    if (req.method === 'GET' && url.pathname === '/api/jira/state') {
      if (!jiraReady() && !CFG.demo) return send(res, 400, { error: 'Jira não configurado no servidor' });
      return send(res, 200, jiraState());
    }
    // Atualização manual: no máximo 1 por JIRA_MIN_MANUAL_MS, para o botão não esgotar o limite do Jira
    if (req.method === 'POST' && url.pathname === '/api/jira/sync') {
      if (!jiraReady())
        return send(res, CFG.demo ? 200 : 400, CFG.demo ? jiraState() : { error: 'Jira não configurado' });
      const wait = jcache.syncedAt + CFG.sync.minManualMs - Date.now();
      if (wait > 0) return send(res, 200, { ...jiraState(), throttled: true, retryInMs: wait });
      await syncJira();
      return send(res, 200, jiraState());
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
  if (CFG.demo) {
    seedDemoJira();
    return startDemo();
  }
  startJiraSync();
  const jenkinsOn = CFG.jenkins.url && CFG.jenkins.jobs.length;
  if (!jenkinsOn && !ghReady()) {
    log(
      'Nenhuma fonte configurada (JENKINS_URL/JENKINS_JOBS ou GITHUB_TOKEN/GITHUB_WORKFLOWS). Use DEMO=true para testar.'
    );
    return;
  }
  log(`Jira: ${jiraReady() ? CFG.jira.url : 'desligado'}`);
  if (jenkinsOn) {
    log(`Jenkins: ${CFG.jenkins.url} · jobs: ${CFG.jenkins.jobs.join(', ')}`);
    discover();
    setInterval(discover, CFG.jenkins.discoverMs);
  }
  if (ghReady()) {
    log(`GitHub Actions: ${CFG.github.api} · workflows: ${CFG.github.workflows.join(', ')}`);
    ghDiscover();
    setInterval(ghDiscover, CFG.github.discoverMs);
  }
});
