/* ------------------------------------------------------------------ */
/* Eventos (SSE)                                                       */
/* ------------------------------------------------------------------ */
import { observe } from './historico.js';

export const clients = new Set();
export const recent = []; // últimos eventos, reenviados a quem conecta
export const MAX_RECENT = 300;

// keep=false: evento só para quem está conectado (não entra no reenvio dos últimos eventos)
export function emit(type, data, keep = true) {
  observe(type, data);
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  if (keep) {
    recent.push(msg);
    if (recent.length > MAX_RECENT) recent.shift();
  }
  for (const res of clients) res.write(msg);
}
