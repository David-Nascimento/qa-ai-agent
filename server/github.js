import { CFG, log, redact, sleep } from './config.js';
import { emit } from './eventos.js';
import { fetchRetry, githubThrottle, httpError, isTransient } from './http.js';
import { active, afterBuild, parseLines } from './jenkins.js';

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
export const ghReady = () => !!(CFG.github.token && CFG.github.workflows.length);
export const ghHeaders = () => ({
  Authorization: `Bearer ${CFG.github.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});
// limite informado pelo GitHub na última resposta
export const ghRate = { limit: null, remaining: null, reset: 0 };
export const ghEtags = new Map(); // caminho → { etag, body }

// "dono/repo/arquivo.yml" → { repo, file } se o job pertence a um workflow configurado; senão null
export function ghParse(job) {
  const m = String(job).match(/^([^/]+\/[^/]+)\/([^/]+\.ya?ml)$/i);
  if (!m) return null;
  const low = x => x.toLowerCase();
  return CFG.github.workflows.some(w => low(w) === low(m[1]) || low(w) === low(job))
    ? { repo: m[1], file: m[2] }
    : null;
}

// Job do GitHub: pelo padrão dono/repo/arquivo.yml configurado ou por já estar em acompanhamento
// (workflows dinâmicos não têm arquivo .yml no caminho)
export const isGhJob = job => !!ghParse(job) || [...active.values()].some(s => s.src === 'github' && s.job === job);

export function ghGuard() {
  if (ghRate.remaining === 0 && ghRate.reset * 1000 > Date.now()) {
    const e = new Error(`GitHub: limite de chamadas esgotado até ${new Date(ghRate.reset * 1000).toISOString()}`);
    e.limited = true;
    throw e;
  }
}

export async function ghRaw(path, opts = {}) {
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
export async function ghJson(path) {
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
export function ghWait() {
  const low = ghRate.remaining !== null && ghRate.remaining < 200 ? 4 : 1;
  const base =
    CFG.github.pollMs * githubThrottle.factor * low * Math.max(1, Math.ceil(active.size / CFG.track.fastBuilds));
  const untilReset = ghRate.remaining === 0 ? Math.min(300000, Math.max(0, ghRate.reset * 1000 - Date.now())) : 0;
  return Math.max(base, untilReset);
}

// Jobs do run, com paginação (matrizes grandes passam de 100 jobs). Limite de 5 páginas por leitura.
export async function ghJobs(repo, runId) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const d = await ghJson(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
    out.push(...(d.jobs || []));
    if (out.length >= (d.total_count || 0) || !(d.jobs || []).length) break;
  }
  return out;
}

// Estado do job do GitHub → status de estágio no formato que a tela já conhece (o mesmo do Jenkins)
export function ghStage(j) {
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
export const ghFile = run =>
  String(run.path || '')
    .split('/')
    .pop()
    .split('@')[0] || String(run.workflow_id);

// Lê o log de um job concluído e transforma as linhas de resultado em eventos "scenario"
export async function ghJobLog(st, j) {
  if (j.conclusion === 'skipped' || (CFG.github.logJobs && !CFG.github.logJobs.test(j.name))) return;
  try {
    const res = await ghRaw(`/repos/${st.repo}/actions/jobs/${j.id}/logs`);
    parseLines(st, await res.text(), true);
  } catch (e) {
    if (isTransient(e)) throw e; // tenta de novo na próxima leitura
    log(`${st.job}#${st.build}: log do job "${j.name}" indisponível (${e.message})`); // expirado ou sem permissão
  }
}

export async function ghTrack(repo, run) {
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
        const jobs = await ghJobs(repo, run.id);
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
    emit('build_end', {
      job,
      build: run.run_number,
      status: 'Falha',
      error: redact(e.message),
      source: 'GitHub Actions',
    });
  } finally {
    active.delete(key);
  }
}

export async function ghFinish(st, r) {
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
export async function ghDiscover() {
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
export async function ghTrigger(job, params = {}) {
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
export async function ghStop(job, build) {
  const st = active.get(`${job}#${build}`);
  if (!st?.runId) throw new Error('Run não está em acompanhamento');
  await ghRaw(`/repos/${st.repo}/actions/runs/${st.runId}/cancel`, { method: 'POST' });
}
