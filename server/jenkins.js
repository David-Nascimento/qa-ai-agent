import { CFG, b64, log, redact, sleep } from './config.js';
import { emit } from './eventos.js';
import { fetchRetry, httpError, isTransient, jenkinsThrottle } from './http.js';
import { jiraReady, reportBug, syncSoon } from './jira.js';

/* ------------------------------------------------------------------ */
/* Jenkins                                                             */
/* ------------------------------------------------------------------ */
export const jobPath = job =>
  job
    .split('/')
    .map(s => 'job/' + encodeURIComponent(s))
    .join('/');
export const jenkinsHeaders = () => ({ Authorization: 'Basic ' + b64(`${CFG.jenkins.user}:${CFG.jenkins.token}`) });

export async function jenkinsRaw(path, opts = {}) {
  const res = await fetchRetry(
    'Jenkins',
    CFG.jenkins.url + path,
    { ...opts, headers: { ...jenkinsHeaders(), ...(opts.headers || {}) } },
    jenkinsThrottle
  );
  if (!res.ok) throw httpError('Jenkins', res, path);
  return res;
}
export const jenkinsJson = async path => (await jenkinsRaw(path)).json();

// Formatos reconhecidos por padrão (Playwright "list", Cypress/Mocha "spec", Jest, TAP):
//   ✓  3 [chromium] › checkout.spec.ts:12:5 › CT-001 Fluxo de compra completo (1.2s)
//   ✘  4 [chromium] › checkout.spec.ts:30:5 › CT-004 Timeout na API de pagamento (30.0s)
//   ✓ CT-002 Aplicar cupom de desconto (842ms)
export const DEFAULT_LINE =
  /^\s*(?<status>✓|✔|√|✗|✘|×|✕)\s+(?:\d+\s+)?(?<name>.+?)\s*\((?<dur>\d+(?:[.,]\d+)?)\s*(?<unit>ms|s|m)\)\s*$/u;
export const PASS = new Set(['✓', '✔', '√', 'ok', 'OK', 'pass', 'passed', 'PASS', 'PASSED', 'Passed', 'SUCCESS']);
export const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

export function toSeconds(v, unit) {
  const n = parseFloat(String(v).replace(',', '.'));
  return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : n;
}
export function cleanName(name) {
  // remove o prefixo "[chromium] › arquivo.spec.ts:12:5 › " do Playwright
  const parts = name.split(' › ');
  return parts.length > 1 ? parts.slice(-1)[0].trim() : name.trim();
}
export function respFor(st, name) {
  if (st.resp.has(name)) return st.resp.get(name);
  const id = name.match(/CT-\d+/)?.[0];
  if (!id) return null;
  for (const [k, v] of st.resp) if (k.includes(id)) return v;
  return null;
}

export function parseLines(st, text, final) {
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

export async function pollStages(st) {
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

export const active = new Map();

// Intervalo de leitura do log: cresce com o número de builds acompanhados e quando o Jenkins pede calma (429)
export const pollWait = () =>
  CFG.jenkins.pollMs * jenkinsThrottle.factor * Math.max(1, Math.ceil(active.size / CFG.track.fastBuilds));

export async function track(job, b) {
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
    emit('build_end', { job, build: b.number, status: 'Falha', error: redact(e.message) });
  } finally {
    active.delete(key);
  }
}

export async function finish(st) {
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
export async function afterBuild(st, buildUrl) {
  syncSoon();
  if (CFG.jira.autoBug && jiraReady()) {
    for (const [name, s] of st.scen) {
      if (s !== 'fail') continue;
      await reportBug({ job: st.job, build: st.build, scenario: name, buildUrl }).catch(e => log(`Jira: ${e.message}`));
    }
  }
}

export async function discover() {
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

export async function triggerBuild(job, params) {
  const path = `/${jobPath(job)}/${params && Object.keys(params).length ? 'buildWithParameters' : 'build'}`;
  const body = params ? new URLSearchParams(params) : undefined;
  await jenkinsRaw(path, { method: 'POST', body });
  setTimeout(discover, 4000); // o build entra na fila e começa alguns segundos depois
}
export const stopBuild = (job, build) => jenkinsRaw(`/${jobPath(job)}/${build}/stop`, { method: 'POST' });
