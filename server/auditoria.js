// Log de auditoria: uma linha JSON por ação sensível (quem, de onde, o quê). Nunca grava chave nem token.
// AUDIT_FILE=off desliga. O arquivo é criado com permissão 600 e gira ao passar de AUDIT_MAX_BYTES (guarda 1 cópia).
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CFG, log, redact } from './config.js';

const limpa = v =>
  typeof v === 'string'
    ? redact(v)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 200)
    : v;

export function audit(evento, ip, extra = {}) {
  const file = CFG.audit.file;
  if (!file) return;
  try {
    const linha = { t: new Date().toISOString(), evento, ip: limpa(String(ip || '?')) };
    for (const [k, v] of Object.entries(extra)) linha[k] = limpa(v);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size > CFG.audit.maxBytes) renameSync(file, `${file}.1`);
    } catch {
      /* ainda não existe */
    }
    appendFileSync(file, JSON.stringify(linha) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (e) {
    log(`Falha ao gravar auditoria: ${e.message}`);
  }
}
