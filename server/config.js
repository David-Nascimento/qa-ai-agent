import { fileURLToPath } from 'node:url';
import { abrir, carregarMestra, estaSelado, ehHash } from './cripto.js';

export const env = process.env;
export const list = v =>
  (v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Número de uma variável de ambiente: vazio ou inválido (ex.: "abc") volta ao padrão, e nunca abaixo do mínimo.
// Sem isso, POLL_MS=abc viraria NaN e o setInterval dispararia sem parar, martelando o Jenkins.
export const num = (v, d, min = 0) => {
  if (v === undefined || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, n) : d;
};
// Expressão regular de uma variável: se for inválida, o servidor avisa qual variável e para
export const rx = (name, v, d = null, flags = 'u') => {
  try {
    return v ? new RegExp(v, flags) : d;
  } catch (e) {
    console.error(`${name} inválida: ${e.message}`);
    process.exit(1);
  }
};

// Falha de configuração de segurança: diz qual variável está errada e encerra (nunca sobe "meio aberto")
export const fatal = msg => {
  console.error('ERRO de configuração: ' + msg);
  process.exit(1);
};

// Segredos: aceitam texto puro (legado) ou o formato cifrado "enc:v1:..." gerado por `npm run segredos -- cifrar`.
// A chave-mestra vem de SECRETS_KEY_FILE (preferido) ou SECRETS_KEY e é apagada do ambiente logo depois de lida,
// para não vazar para processos filhos nem para dumps de variáveis.
let MASTER = null;
try {
  MASTER = carregarMestra(env);
} catch (e) {
  fatal(e.message);
}
delete process.env.SECRETS_KEY;
// A chave-mestra fica só na memória: serve para decifrar o .env e para cifrar as integrações salvas pela tela
export const getMaster = () => MASTER;
export const SECRET_NAMES = ['JENKINS_TOKEN', 'GITHUB_TOKEN', 'JIRA_TOKEN', 'API_KEY'];
export const sec = name => {
  const v = (env[name] || '').trim();
  if (!estaSelado(v)) return v;
  if (!MASTER) fatal(`${name} está cifrado, mas falta SECRETS_KEY_FILE (ou SECRETS_KEY) para decifrar.`);
  try {
    return abrir(v, MASTER);
  } catch (e) {
    return fatal(`${name}: ${e.message}`);
  }
};

export const CFG = {
  port: num(env.PORT, 3000),
  // origem permitida pelo CORS; vazio = decidido abaixo (loopback: *, exposto: nenhuma origem externa)
  cors: (env.CORS_ORIGIN || '').trim(),
  // interface de rede: sem HOST, escuta só em 127.0.0.1 quando não há chave de API; com chave, em todas
  host: (env.HOST || '').trim(),
  apiKey: sec('API_KEY'),
  // hash scrypt da chave de API (alternativa a API_KEY: o servidor nunca guarda a chave em si)
  apiKeyHash: (env.API_KEY_HASH || '').trim(),
  demo: env.DEMO === 'true',
  jenkins: {
    url: (env.JENKINS_URL || '').replace(/\/$/, ''),
    user: env.JENKINS_USER || '',
    token: sec('JENKINS_TOKEN'),
    jobs: list(env.JENKINS_JOBS),
    pollMs: num(env.POLL_MS, 3000, 50),
    discoverMs: num(env.DISCOVER_MS, 30000, 1000),
    logRegex: rx('LOG_REGEX', env.LOG_REGEX),
    respRegex: rx('RESP_REGEX', env.RESP_REGEX, /\[resp\]\s+(?<name>.+?)\s+(?<ms>\d+)\s*ms/u),
  },
  // GitHub Actions: cada workflow é acompanhado como um "job" do Jenkins (job = dono/repositório/arquivo.yml)
  github: {
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    token: sec('GITHUB_TOKEN'),
    // "dono/repo/workflow.yml" acompanha um workflow · "dono/repo" acompanha todos os workflows do repositório
    workflows: list(env.GITHUB_WORKFLOWS),
    pollMs: num(env.GITHUB_POLL_MS, 10000, 50),
    discoverMs: num(env.GITHUB_DISCOVER_MS, 30000, 1000),
    // só baixa o log dos jobs cujo nome casa com esta expressão (cada log custa 1 chamada)
    logJobs: rx('GITHUB_LOG_JOBS', env.GITHUB_LOG_JOBS, null, 'iu'),
  },
  jira: {
    url: (env.JIRA_URL || '').replace(/\/$/, ''),
    email: env.JIRA_EMAIL || '',
    token: sec('JIRA_TOKEN'),
    project: env.JIRA_PROJECT || '',
    version: env.JIRA_API_VERSION || '3',
    autoBug: env.JIRA_AUTO_BUG === 'true',
    issueType: env.JIRA_ISSUE_TYPE || 'Bug',
    labels: list(env.JIRA_LABELS || 'qa-ai-agent'),
    scenarioJql: env.JIRA_SCENARIOS_JQL || 'project = QA AND issuetype = Test ORDER BY key',
    pipelineField: env.JIRA_PIPELINE_FIELD || 'components',
    // "Meus cards": cache da consulta (o botão da tela não esgota o limite do Jira) e janela dos já concluídos
    mineTtlMs: num(env.JIRA_MINE_TTL_MS, 60000, 5000),
    mineDoneDays: num(env.JIRA_MINE_DONE_DAYS, 7, 0),
    // basic = usuário/e-mail + token · bearer = token pessoal (PAT) do Jira Data Center
    auth: env.JIRA_AUTH === 'bearer' ? 'bearer' : 'basic',
  },
  // Sincronização periódica do Jira (cenários + ciclos). 0 desliga.
  sync: {
    ms: num(env.JIRA_SYNC_MS, 300000), // 0 desliga
    fullMs: num(env.JIRA_FULL_SYNC_MS, 6 * 3600000, 60000),
    afterBuildMs: num(env.JIRA_AFTER_BUILD_MS, 20000),
    gapMs: num(env.JIRA_GAP_MS, 200),
    minManualMs: num(env.JIRA_MIN_MANUAL_MS, 30000),
  },
  // Ciclos de teste do Zephyr Scale (Server/Data Center), pela API ATM do próprio Jira
  zephyr: {
    on: env.ZEPHYR === 'true',
    api: env.ZEPHYR_API_PATH || '/rest/atm/1.0',
    tql: env.ZEPHYR_TQL || '',
    caseField: env.ZEPHYR_CASE_FIELD || '',
    max: num(env.ZEPHYR_MAX_CYCLES, 100, 1),
    activeDays: num(env.ZEPHYR_ACTIVE_DAYS, 30),
    closed: list(env.ZEPHYR_CLOSED_STATUS || 'Done').map(s => s.toLowerCase()),
    cycleUrl: env.ZEPHYR_CYCLE_URL || '{jira}/secure/Tests.jspa#/testPlayer/{key}',
  },
  // Proteção contra limite de requisições (HTTP 429/503) e quedas passageiras
  http: {
    retries: num(env.HTTP_RETRIES, 3),
    backoffMs: num(env.HTTP_BACKOFF_MS, 1000),
    maxWaitMs: num(env.HTTP_MAX_WAIT_MS, 60000),
  },
  // Segurança
  security: {
    tlsCert: env.TLS_CERT_FILE || '',
    tlsKey: env.TLS_KEY_FILE || '',
    allowInsecureUpstream: env.ALLOW_INSECURE_UPSTREAM === 'true',
    // Dados que chegam ao servidor (chave da API, tokens das integrações) só são aceitos por conexão criptografada
    // (HTTPS) ou da própria máquina. ALLOW_INSECURE_TRANSPORT=true desliga essa exigência (não recomendado).
    allowInsecureTransport: env.ALLOW_INSECURE_TRANSPORT === 'true',
    tlsMinVersion: /^TLSv1\.[23]$/.test(env.TLS_MIN_VERSION || '') ? env.TLS_MIN_VERSION : 'TLSv1.2',
    // a chave na URL (?key=) vaza em logs, histórico e Referer; por padrão só o cabeçalho x-api-key vale
    allowUrlKey: env.ALLOW_URL_KEY === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    ticketMs: num(env.TICKET_TTL_MS, 30000, 1000),
    maxFails: num(env.AUTH_MAX_FAILS, 10, 1),
    failWindowMs: num(env.AUTH_FAIL_WINDOW_MS, 300000, 1000),
    maxClients: num(env.MAX_SSE_CLIENTS, 200, 1),
  },
  // Histórico de execuções em arquivo (HISTORY_FILE=off desliga; ignorado no modo DEMO)
  // Integrações salvas pela tela (tokens cifrados com a chave-mestra); INTEGRATIONS_FILE=off desliga
  integrations: {
    file: /^(off|false|0)$/i.test(env.INTEGRATIONS_FILE || '')
      ? ''
      : env.INTEGRATIONS_FILE || fileURLToPath(new URL('./data/integracoes.json', import.meta.url)),
  },
  // Auditoria de ações sensíveis (disparar/parar build, salvar integração, falhas de chave); AUDIT_FILE=off desliga
  audit: {
    file: /^(off|false|0)$/i.test(env.AUDIT_FILE || '')
      ? ''
      : env.AUDIT_FILE || fileURLToPath(new URL('./data/auditoria.log', import.meta.url)),
    maxBytes: num(env.AUDIT_MAX_BYTES, 10 * 1024 * 1024, 10000),
  },
  history: {
    file: /^(off|false|0)$/i.test(env.HISTORY_FILE || '')
      ? ''
      : env.HISTORY_FILE || fileURLToPath(new URL('./data/historico.json', import.meta.url)),
    max: num(env.HISTORY_MAX, 5000, 10),
  },
  track: {
    stagesEvery: num(env.STAGES_EVERY, 3, 1),
    maxErrors: num(env.TRACK_MAX_ERRORS, 5),
    maxBuilds: num(env.MAX_TRACKED_BUILDS, 10, 1),
    fastBuilds: 5, // acima disso o intervalo de leitura aumenta
  },
};

if (CFG.apiKeyHash && !ehHash(CFG.apiKeyHash))
  fatal('API_KEY_HASH inválido: gere com `npm run segredos -- hash-chave`.');
if (CFG.apiKey && CFG.apiKeyHash) fatal('defina só um: API_KEY ou API_KEY_HASH.');
if (!!CFG.security.tlsCert !== !!CFG.security.tlsKey) fatal('TLS_CERT_FILE e TLS_KEY_FILE devem ser definidos juntos.');
// Credenciais só viajam por HTTPS: um token em http:// passa em claro pela rede.
// Exceção: loopback (mesma máquina) ou ALLOW_INSECURE_UPSTREAM=true (rede interna confiável, por sua conta e risco).
export const isLoopback = h => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h);

// Falha fechado: sem chave de API o servidor não pode ficar acessível pela rede, e a chave tem de ser forte.
const MIN_API_KEY = 16;
const hasAuth = !!(CFG.apiKey || CFG.apiKeyHash);
if (CFG.apiKey && (CFG.apiKey.length < MIN_API_KEY || new Set(CFG.apiKey).size < 6))
  fatal(
    `API_KEY fraca: use pelo menos ${MIN_API_KEY} caracteres variados. Gere uma com \`npm run --silent segredos -- gerar-chave\` ou prefira API_KEY_HASH.`
  );
if (!CFG.host) CFG.host = hasAuth ? '' : '127.0.0.1';
export const bindLoopback = isLoopback(CFG.host);
if (!hasAuth && !bindLoopback)
  fatal(
    `HOST=${CFG.host} deixaria o servidor aberto na rede sem chave. Defina API_KEY_HASH (ou API_KEY), ou use HOST=127.0.0.1.`
  );
// CORS: sem CORS_ORIGIN, só a própria máquina aceita qualquer origem; exposto na rede, nenhuma origem externa.
if (!CFG.cors) CFG.cors = hasAuth && !bindLoopback ? '' : '*';
if (CFG.cors && CFG.cors !== '*' && !/^https?:\/\/[^\s*]+$/i.test(CFG.cors) && CFG.cors !== 'null')
  fatal('CORS_ORIGIN inválido: use uma origem exata (ex.: https://qa.suaempresa.com) ou *.');
export function requireHttps(name, u, hasSecret) {
  if (!u || !hasSecret || CFG.security.allowInsecureUpstream) return;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return fatal(`${name} não é uma URL válida.`);
  }
  if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname))
    fatal(
      `${name} usa http:// e enviaria credenciais sem criptografia. Use https:// (ou ALLOW_INSECURE_UPSTREAM=true em rede interna confiável).`
    );
}
requireHttps('JENKINS_URL', CFG.jenkins.url, CFG.jenkins.token);
requireHttps('GITHUB_API_URL', CFG.github.api, CFG.github.token);
requireHttps('JIRA_URL', CFG.jira.url, CFG.jira.token);

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const b64 = s => Buffer.from(s).toString('base64');
// Nenhum segredo (nem Authorization) pode aparecer em log ou em mensagem de erro
export const SECRET_VALUES = [CFG.jenkins.token, CFG.github.token, CFG.jira.token, CFG.apiKey].filter(
  v => v && v.length >= 6
);
export const redact = v => {
  let t = typeof v === 'string' ? v : v instanceof Error ? v.stack || v.message : String(v);
  for (const s of SECRET_VALUES) t = t.split(s).join('***');
  return t
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/([?&](?:key|ticket|token|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***');
};
export const log = (...a) => console.log(new Date().toISOString(), ...a.map(redact));
