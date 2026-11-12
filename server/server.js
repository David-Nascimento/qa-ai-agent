// QA AI Agent — servidor de tempo real
// Lê as execuções do Jenkins e do GitHub Actions e integra com o Jira usando somente as APIs REST,
// e envia os eventos para a plataforma via Server-Sent Events (SSE).
// Requer Node.js 20.6+ (fetch nativo e --env-file). Sem dependências externas.

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { CFG, fatal, log, redact } from './config.js';
import { DEMO_SCENARIOS, seedDemoJira, startDemo } from './demo.js';
import { clients, recent } from './eventos.js';
import { flushHistory, listHistory, loadHistory } from './historico.js';
import { ghDiscover, ghParse, ghRate, ghReady, ghStop, ghTrigger, isGhJob } from './github.js';
import { githubThrottle, jenkinsThrottle, jiraThrottle } from './http.js';
import { active, discover, stopBuild, triggerBuild } from './jenkins.js';
import { jcache, jiraReady, jiraScenarios, jiraState, reportBug, startJiraSync, syncJira } from './jira.js';
import {
  SEC_HEADERS,
  TLS_ON,
  authRequired,
  authorized,
  blockedMs,
  clientError,
  clientIp,
  newTicket,
  presentedKey,
  readJson,
  registerFail,
  send,
  tooMany,
  useTicket,
} from './web.js';

// Só jobs configurados podem ser disparados ou parados: sem isso, qualquer pessoa com acesso à rota
// executaria qualquer job do Jenkins (ou, com "..", chamaria outros endereços dele).
// Aceita o caminho completo (Pasta/Job) ou só o nome do job, se ele for único na lista.
function jenkinsJobOf(job) {
  const all = CFG.jenkins.jobs;
  if (all.includes(job)) return job;
  const hit = all.filter(j => j.split('/').pop() === job);
  return hit.length === 1 ? hit[0] : null;
}

const handler = async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'URL inválida' });
  }
  const ip = clientIp(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CFG.cors,
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (url.pathname === '/api/health') {
    // sem chave, mostra só o necessário; nomes de jobs/workflows e limite do token exigem a chave
    const tried = !!presentedKey(req, url);
    if (tried && blockedMs(ip)) return tooMany(res, blockedMs(ip));
    const full = authorized(req, url);
    if (tried && !full) registerFail(ip);
    return send(res, 200, {
      ok: true,
      demo: CFG.demo,
      jenkins: !!CFG.jenkins.url,
      ...(full && { jobs: CFG.jenkins.jobs }),
      github: ghReady(),
      ...(full && {
        workflows: CFG.github.workflows,
        githubRate: { limit: ghRate.limit, remaining: ghRate.remaining, reset: ghRate.reset || null },
      }),
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
  if (blockedMs(ip)) return tooMany(res, blockedMs(ip));
  // o /events também aceita um tíquete de uso único no lugar da chave (ver newTicket)
  const viaTicket = req.method === 'GET' && url.pathname === '/events' && useTicket(url.searchParams.get('ticket'));
  if (!viaTicket && !authorized(req, url)) {
    registerFail(ip);
    return send(res, 401, { error: 'API key inválida' });
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/ticket') {
      return send(res, 201, { ticket: newTicket(), expiresInMs: CFG.security.ticketMs });
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (clients.size >= CFG.security.maxClients)
        return send(res, 503, { error: 'Limite de conexões em tempo real atingido' });
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
    if (req.method === 'GET' && url.pathname === '/api/history') {
      return send(res, 200, { runs: listHistory(Number(url.searchParams.get('limit')) || 1000) });
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
      else {
        const j = jenkinsJobOf(job);
        if (!j) throw clientError(403, `Job "${job}" não está em JENKINS_JOBS`);
        await triggerBuild(j, params);
      }
      return send(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const { job, build } = await readJson(req);
      if (!job || !build) return send(res, 400, { error: 'Informe "job" e "build"' });
      if (!/^\d+$/.test(String(build))) throw clientError(400, '"build" deve ser um número');
      if (!CFG.demo) {
        if (isGhJob(job)) await ghStop(job, build);
        else {
          const j = jenkinsJobOf(job);
          if (!j) throw clientError(403, `Job "${job}" não está em JENKINS_JOBS`);
          await stopBuild(j, build);
        }
      }
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
    send(res, e.client || 502, { error: e.client ? e.message : redact(e.message) });
  }
};

// HTTPS nativo opcional (TLS_CERT_FILE + TLS_KEY_FILE); sem ele, use um proxy reverso com TLS na frente
let tlsOpts = null;
if (TLS_ON) {
  try {
    tlsOpts = {
      cert: readFileSync(CFG.security.tlsCert),
      key: readFileSync(CFG.security.tlsKey),
      minVersion: 'TLSv1.2',
    };
  } catch (e) {
    fatal(`não consegui ler o certificado TLS (${e.code || e.message})`);
  }
}
const server = tlsOpts
  ? https.createServer({ ...tlsOpts, maxHeaderSize: 16384 }, handler)
  : http.createServer({ maxHeaderSize: 16384 }, handler);
// Conexões lentas (slowloris) não seguram o servidor; o SSE não é afetado, pois a requisição já terminou
server.headersTimeout = 15000;
server.requestTimeout = 30000;

// Uma promessa rejeitada e esquecida derrubaria o processo (Node 15+); aqui vira só um aviso no log
process.on('unhandledRejection', e => log(`Erro não tratado: ${e?.stack || e}`));
// Encerra limpo (Docker/systemd mandam SIGTERM): fecha o servidor e as conexões SSE
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    log(`${sig}: encerrando`);
    for (const c of clients) c.end();
    flushHistory();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });

loadHistory();
server.listen(CFG.port, () => {
  log(`QA AI Agent — servidor em ${TLS_ON ? 'https' : 'http'}://localhost:${CFG.port}`);
  if (!TLS_ON && authRequired())
    log('Aviso: sem TLS, a chave de API trafega em claro. Use TLS_CERT_FILE/TLS_KEY_FILE ou um proxy HTTPS na frente.');
  if (!authRequired() && CFG.cors === '*' && !CFG.demo)
    log(
      'ATENÇÃO: sem API_KEY e com CORS_ORIGIN=*, qualquer página pode disparar e parar builds. Defina API_KEY e CORS_ORIGIN.'
    );
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
