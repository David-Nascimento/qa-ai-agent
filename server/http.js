import { CFG, log, sleep } from './config.js';

/* ------------------------------------------------------------------ */
/* HTTP com espera e nova tentativa                                    */
/* ------------------------------------------------------------------ */
// Limitador por serviço: sobe quando recebe 429 e desce aos poucos nas respostas boas.
// O fator multiplica o intervalo de leitura do Jenkins (POLL_MS).
export const makeThrottle = () => ({
  factor: 1,
  hit() {
    this.factor = Math.min(8, this.factor * 2);
  },
  ok() {
    if (this.factor > 1) this.factor = Math.max(1, this.factor * 0.95);
  },
});
export const jenkinsThrottle = makeThrottle();
export const jiraThrottle = makeThrottle();
export const githubThrottle = makeThrottle();

export const TRANSIENT = new Set([429, 502, 503, 504]);
// O GitHub avisa o limite com 403 (ou 429) + x-ratelimit-remaining: 0 (limite primário) ou Retry-After
// (limite secundário). Um 403 comum (sem permissão) não tem esses cabeçalhos e continua sendo erro.
export const rateLimited = res =>
  !!res &&
  (res.status === 403 || res.status === 429) &&
  (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
// Retry-After pode vir em segundos ou como data; no limite primário do GitHub vale o x-ratelimit-reset
export function retryAfterMs(headers) {
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

export function httpError(label, res, path) {
  const e = new Error(`${label} ${res.status} em ${path}`);
  e.status = res.status;
  e.limited = rateLimited(res); // limite de requisições: espera e tenta de novo, não é falha do build
  return e;
}

// GET repete em 429/502/503/504, no limite do GitHub e em erro de rede. POST repete só quando o
// servidor recusou por limite (429 ou limite do GitHub): a ação não foi executada, então não duplica.
export async function fetchRetry(label, url, opts = {}, throttle = null) {
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
    res?.body?.cancel().catch(() => {}); // libera a conexão: sem isso cada repetição deixaria um socket preso
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
export const isTransient = e => e.status === undefined || e.status === 429 || e.status >= 500 || e.limited === true;
