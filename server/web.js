import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { conferirChave } from './cripto.js';
import { CFG } from './config.js';

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
// Cabeçalhos de segurança em toda resposta (a API só devolve JSON/SSE, então a CSP é a mais restritiva possível)
export const TLS_ON = !!(CFG.security.tlsCert && CFG.security.tlsKey);
export const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  Vary: 'Origin',
  ...(TLS_ON && { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
};
export const corsHeaders = () => (CFG.cors ? { 'Access-Control-Allow-Origin': CFG.cors } : {});
export function send(res, code, data, extra = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
    ...extra,
  });
  res.end(JSON.stringify(data));
}
// Erro do cliente (corpo inválido, job fora da lista): responde 4xx em vez de 502
export const clientError = (status, msg) => Object.assign(new Error(msg), { client: status });
// Parâmetros de build vindos do cliente: objeto simples, poucas chaves de nome comum e valores de texto curtos
export function checkParams(params) {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) throw clientError(400, '"params" deve ser um objeto');
  const e = Object.entries(params);
  if (e.length > 25) throw clientError(400, 'params demais (máximo 25)');
  for (const [k, v] of e)
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(k) || (v !== null && typeof v === 'object') || String(v).length > 1000)
      throw clientError(400, `parâmetro "${k}" inválido`);
  return params;
}
export async function readJson(req) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 1e6) throw clientError(413, 'Corpo muito grande');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw clientError(400, 'JSON inválido');
  }
}
// Comparação em tempo constante: a chave não vaza pelo tempo de resposta
export const sameKey = (a, b) => {
  const x = Buffer.from(String(a ?? '')),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
// A requisição chegou por canal criptografado?
//  - direto: HTTPS nativo (TLS_CERT_FILE/TLS_KEY_FILE) ou a própria máquina (loopback)
//  - por proxy (X-Forwarded-*): só vale se TRUST_PROXY=true e o proxy disser que o cliente usou https
// Um proxy na mesma máquina não torna o cliente "local": os cabeçalhos do proxy são checados primeiro.
const isLoopbackAddr = a => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));
export function secureTransport(req) {
  if (CFG.security.allowInsecureTransport) return true;
  const h = req.headers;
  if (h['x-forwarded-for'] || h['x-forwarded-proto'] || h.forwarded) {
    if (!CFG.security.trustProxy) return false;
    return (
      String(h['x-forwarded-proto'] || '')
        .split(',')
        .pop()
        .trim()
        .toLowerCase() === 'https'
    );
  }
  return !!req.socket.encrypted || isLoopbackAddr(req.socket.remoteAddress);
}
export const insecure = res =>
  send(res, 403, {
    error: 'Conexão não criptografada. Acesse o servidor por HTTPS para enviar a chave da API e os tokens.',
    code: 'tls_required',
  });
export const authRequired = () => !!(CFG.apiKey || CFG.apiKeyHash);
// Chave apresentada: sempre o cabeçalho; "?key=" só com ALLOW_URL_KEY=true (compatibilidade), pois a URL vai para logs e histórico
export const presentedKey = (req, url) =>
  (req.headers['x-api-key'] || (CFG.security.allowUrlKey ? url.searchParams.get('key') : '') || '').toString();
// Com API_KEY_HASH, o scrypt é caro: depois de uma conferência válida guardamos só o SHA-256 da chave
let verifiedDigest = null;
export const digest = k => createHash('sha256').update(k).digest();
export function keyOk(k) {
  if (!k) return false;
  if (CFG.apiKey) return sameKey(k, CFG.apiKey);
  const d = digest(k);
  if (verifiedDigest && timingSafeEqual(d, verifiedDigest)) return true;
  if (!conferirChave(k, CFG.apiKeyHash)) return false;
  verifiedDigest = d;
  return true;
}
export const authorized = (req, url) => !authRequired() || keyOk(presentedKey(req, url));

// Bloqueio de tentativas: N falhas de autenticação por IP numa janela => 429 (freia adivinhação de chave)
export const fails = new Map();
// Atrás de proxy confiável vale o ÚLTIMO item do X-Forwarded-For (o que o nosso proxy acrescentou);
// o primeiro é escrito pelo cliente e pode ser forjado para fugir do bloqueio ou para trancar outra pessoa.
export const clientIp = req =>
  (CFG.security.trustProxy &&
    String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .pop()
      .trim()) ||
  req.socket.remoteAddress ||
  '?';
export const blockedMs = ip => {
  const f = fails.get(ip);
  if (!f) return 0;
  if (Date.now() - f.first > CFG.security.failWindowMs) {
    fails.delete(ip);
    return 0;
  }
  return f.n >= CFG.security.maxFails ? CFG.security.failWindowMs - (Date.now() - f.first) : 0;
};
export function registerFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > CFG.security.failWindowMs) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
  if (fails.size > 10000) fails.clear(); // teto de memória
  return fails.get(ip).n;
}
export const tooMany = (res, ms) =>
  send(res, 429, { error: 'Muitas tentativas inválidas; aguarde' }, { 'Retry-After': String(Math.ceil(ms / 1000)) });

// Tíquetes de uso único para o SSE: o EventSource não envia cabeçalhos, então em vez de pôr a chave na URL
// o navegador pede um tíquete (POST /api/ticket, com a chave no cabeçalho) que vale uma conexão e expira em segundos.
export const tickets = new Map();
export function newTicket() {
  const now = Date.now();
  for (const [t, exp] of tickets) if (exp < now) tickets.delete(t);
  if (tickets.size > 1000) tickets.clear();
  const t = randomBytes(24).toString('base64url');
  tickets.set(t, now + CFG.security.ticketMs);
  return t;
}
export function useTicket(t) {
  if (!t) return false;
  const exp = tickets.get(t);
  tickets.delete(t); // uso único, válido ou não
  return !!exp && exp >= Date.now();
}
