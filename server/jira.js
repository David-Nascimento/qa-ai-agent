import { CFG, b64, log, redact, sleep } from './config.js';
import { emit } from './eventos.js';
import { fetchRetry, httpError, isTransient, jiraThrottle } from './http.js';
import { clientError } from './web.js';

/* ------------------------------------------------------------------ */
/* Jira                                                                */
/* ------------------------------------------------------------------ */
export const jiraReady = () =>
  CFG.jira.url && CFG.jira.token && CFG.jira.project && (CFG.jira.auth === 'bearer' || CFG.jira.email);

export const jiraHeaders = () => ({
  Authorization:
    CFG.jira.auth === 'bearer' ? `Bearer ${CFG.jira.token}` : 'Basic ' + b64(`${CFG.jira.email}:${CFG.jira.token}`),
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

export async function jira(path, { method = 'GET', body } = {}) {
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
export const adf = text => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').map(l => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })),
});
export const rich = text => (CFG.jira.version === '3' ? adf(text) : text);

export async function findOpenBug(term) {
  const jql = `project = "${CFG.jira.project}" AND summary ~ "\\"${term.replace(/[\\"]/g, '')}\\"" AND statusCategory != Done ORDER BY created DESC`;
  const q = `jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`;
  const d = await jira(CFG.jira.version === '3' ? `/search/jql?${q}` : `/search?${q}`);
  return d.issues?.[0] || null;
}

export async function reportBug({ job, build, scenario, buildUrl, details = '' }) {
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
export const CASE_KEY = /\b[A-Z][A-Z0-9_]+-T\d+\b/;
export function caseKeyOf(f) {
  const own = CFG.zephyr.caseField ? JSON.stringify(f[CFG.zephyr.caseField] ?? '') : '';
  return (own.match(CASE_KEY) ||
    (f.summary || '').match(CASE_KEY) ||
    (f.labels || []).join(' ').match(CASE_KEY) || [''])[0];
}

export async function jiraScenarios({ jql = CFG.jira.scenarioJql, field = CFG.jira.pipelineField, max = 1000 } = {}) {
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
export const txt = v => (v && typeof v === 'object' ? (v.name ?? v.value ?? '') : (v ?? ''));
export const cycleUrl = key =>
  CFG.zephyr.cycleUrl.replace('{jira}', CFG.jira.url).replace('{key}', encodeURIComponent(key));

export async function zephyrJson(path, params) {
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
export function caseStatus(s) {
  const t = String(txt(s)).toLowerCase();
  if (/not|n[aã]o|unexec/.test(t)) return 'pend';
  if (/pass|aprov/.test(t)) return 'pass';
  if (/fail|reprov|falh/.test(t)) return 'fail';
  if (/block|bloque/.test(t)) return 'blocked';
  if (/progress|andamento/.test(t)) return 'run';
  return 'pend';
}

// Lista os ciclos (sem os itens), do mais recente para o mais antigo
export async function zephyrList() {
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
export async function zephyrItems(key) {
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
export const jcache = {
  syncedAt: 0,
  scenAt: 0,
  fullAt: 0,
  scenarios: new Map(),
  cycles: new Map(),
  error: null,
  running: false,
  again: false,
};

// "Meus cards": issues do projeto atribuídas a quem gerou o token (assignee = currentUser()): abertas e as
// concluídas nos últimos JIRA_MINE_DONE_DAYS dias. Só leitura, presa ao JIRA_PROJECT e com cache curto.
const mine = { at: 0, data: null, pending: null };
export const mineJql = () =>
  `project = "${CFG.jira.project.replace(/"/g, '')}" AND assignee = currentUser() AND (statusCategory != Done` +
  (CFG.jira.mineDoneDays > 0 ? ` OR resolved >= -${CFG.jira.mineDoneDays}d` : '') +
  ') ORDER BY updated DESC';
async function loadMine() {
  const fields = 'summary,status,priority,issuetype,updated,duedate,resolutiondate';
  const cards = [];
  let startAt = 0,
    token = null;
  for (;;) {
    const q = new URLSearchParams({ jql: mineJql(), fields, maxResults: '100' });
    if (CFG.jira.version === '3') {
      if (token) q.set('nextPageToken', token);
    } else q.set('startAt', String(startAt));
    const d = await jira(`${CFG.jira.version === '3' ? '/search/jql' : '/search'}?${q}`);
    for (const it of d.issues || []) {
      const f = it.fields || {};
      cards.push({
        key: it.key,
        summary: f.summary || it.key,
        status: f.status?.name || '',
        category: f.status?.statusCategory?.key || 'new', // new | indeterminate | done
        priority: f.priority?.name || '',
        type: f.issuetype?.name || '',
        updated: f.updated || '',
        due: f.duedate || '',
        resolved: f.resolutiondate || '',
        url: `${CFG.jira.url}/browse/${it.key}`,
      });
    }
    startAt += (d.issues || []).length;
    token = d.nextPageToken || null;
    const mais = CFG.jira.version === '3' ? !!token : d.total != null && startAt < d.total;
    if (!mais || !(d.issues || []).length || cards.length >= 200) break;
  }
  let me = '';
  try {
    me = (await jira('/myself'))?.displayName || '';
  } catch {
    /* o nome é só um enfeite da tela */
  }
  return { me, cards: cards.slice(0, 200), at: Date.now(), days: CFG.jira.mineDoneDays };
}
export async function jiraMine({ force = false } = {}) {
  const fresh = mine.data && Date.now() - mine.at < CFG.jira.mineTtlMs;
  if (fresh && !force) return { ...mine.data, cached: true };
  if (fresh && force && Date.now() - mine.at < 5000) return { ...mine.data, cached: true }; // no máx. 1 consulta a cada 5 s
  mine.pending ||= loadMine()
    .then(d => ((mine.data = d), (mine.at = Date.now()), d))
    .finally(() => (mine.pending = null));
  return { ...(await mine.pending), cached: false };
}
export const resetMine = () => ((mine.data = null), (mine.at = 0));

// Consulta de cenários vinda de fora (query string): limites de tamanho, campo no formato do Jira e, quando há
// JIRA_PROJECT, a consulta é presa a esse projeto — senão a chave da API leria qualquer projeto que o token enxerga.
export function checkScenarioQuery(jql, field) {
  const out = {};
  if (field) {
    if (!/^(customfield_\d{1,6}|[a-z][a-z0-9_]{0,40})$/i.test(field)) throw clientError(400, '"field" inválido');
    out.field = field;
  }
  if (jql) {
    if (jql.length > 2000 || /[\u0000-\u001f]/.test(jql))
      throw clientError(400, '"jql" inválida (limite de 2000 caracteres)');
    const m = jql.match(/^(.*?)(\s+order\s+by\s+.*)?$/is);
    const base = m[1].trim();
    out.jql = CFG.jira.project
      ? `(${base || 'issuetype is not EMPTY'}) AND project = "${CFG.jira.project.replace(/"/g, '')}"${m[2] || ''}`
      : jql;
  }
  return out;
}
// Acrescenta "updated >= -Nm" (tempo relativo: não depende do fuso do Jira) antes do ORDER BY
export function onlyUpdated(jql, mins) {
  const m = jql.match(/^(.*?)(\s+order\s+by\s+.*)?$/is);
  const base = m[1].trim();
  return `${base ? `(${base}) AND ` : ''}updated >= -${mins}m${m[2] || ''}`;
}
// Ciclo "ativo" = não encerrado e atualizado recentemente: só esses são relidos a cada rodada
export const isActive = c =>
  !CFG.zephyr.closed.includes(c.status.toLowerCase()) &&
  !(Date.parse(c.updated) < Date.now() - CFG.zephyr.activeDays * 86400000);

export async function syncCycles(openOnly, changed) {
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
export async function syncJira({ full = false, openOnly = false } = {}) {
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
    jcache.error = redact(e.message);
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
export function syncSoon() {
  if (!CFG.zephyr.on || !CFG.sync.afterBuildMs || !jiraReady()) return;
  clearTimeout(afterTimer);
  afterTimer = setTimeout(() => syncJira({ openOnly: true }), CFG.sync.afterBuildMs);
}

export function startJiraSync() {
  if (!jiraReady() || !CFG.sync.ms) return;
  log(
    `Jira: sincronização a cada ${Math.round(CFG.sync.ms / 1000)} s${CFG.zephyr.on ? ' · ciclos do Zephyr Scale ativos' : ''}`
  );
  syncJira({ full: true });
  setInterval(() => syncJira(), CFG.sync.ms);
}

// Estado entregue à tela: cenários com os ciclos em que aparecem + resumo de cada ciclo
export function jiraState() {
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
