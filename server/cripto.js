// Criptografia de segredos em repouso — somente módulos nativos do Node (node:crypto).
//
// Formato selado:   enc:v1:<salt>:<iv>:<tag>:<texto-cifrado>     (tudo em base64)
//  - AES-256-GCM (cifra autenticada: qualquer alteração do valor é detectada)
//  - chave derivada da chave-mestra com scrypt (N=2^15) e um salt aleatório por valor
//  - IV aleatório de 12 bytes por valor
// Formato de hash:  scrypt:v1:<salt>:<hash>                          (para API_KEY_HASH)
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PREFIXO = 'enc:v1:';
const PREFIXO_HASH = 'scrypt:v1:';
const MIN_MESTRA = 16;
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KDF_HASH = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const estaSelado = v => typeof v === 'string' && v.startsWith(PREFIXO);
export const ehHash = v => typeof v === 'string' && v.startsWith(PREFIXO_HASH);

/** Gera uma chave-mestra aleatória de 256 bits (base64). */
export const gerarChave = () => randomBytes(32).toString('base64');

function validarMestra(mestra) {
  if (typeof mestra !== 'string' || mestra.trim().length < MIN_MESTRA)
    throw new Error(`chave-mestra ausente ou curta demais (mínimo ${MIN_MESTRA} caracteres)`);
  return mestra.trim();
}

/** Cifra um texto. Cada chamada gera salt e IV novos, então o resultado nunca se repete. */
export function selar(texto, mestra) {
  const m = validarMestra(mestra);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const chave = scryptSync(m, salt, 32, KDF);
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  chave.fill(0);
  return PREFIXO + [salt, iv, tag, ct].map(b => b.toString('base64')).join(':');
}

/** Decifra um valor selado. Lança erro se a chave estiver errada ou o valor tiver sido alterado. */
export function abrir(selado, mestra) {
  const m = validarMestra(mestra);
  if (!estaSelado(selado)) throw new Error('valor não está no formato enc:v1');
  const partes = selado.slice(PREFIXO.length).split(':');
  if (partes.length !== 4) throw new Error('valor cifrado malformado');
  const [salt, iv, tag, ct] = partes.map(p => Buffer.from(p, 'base64'));
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('valor cifrado malformado');
  const chave = scryptSync(m, salt, 32, KDF);
  try {
    const d = createDecipheriv('aes-256-gcm', chave, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    throw new Error('não foi possível decifrar (chave-mestra errada ou valor adulterado)');
  } finally {
    chave.fill(0);
  }
}

/** Hash de senha/chave de API (unidirecional) — para guardar API_KEY sem expô-la. */
export function hashChave(chave) {
  const salt = randomBytes(16);
  const h = scryptSync(String(chave), salt, 32, KDF_HASH);
  return `${PREFIXO_HASH}${salt.toString('base64')}:${h.toString('base64')}`;
}

/** Confere uma chave contra um hash, em tempo constante. */
export function conferirChave(chave, hash) {
  if (!ehHash(hash) || typeof chave !== 'string' || !chave) return false;
  const partes = hash.slice(PREFIXO_HASH.length).split(':');
  if (partes.length !== 2) return false;
  const salt = Buffer.from(partes[0], 'base64');
  const esperado = Buffer.from(partes[1], 'base64');
  if (!salt.length || esperado.length !== 32) return false;
  const h = scryptSync(chave, salt, 32, KDF_HASH);
  return timingSafeEqual(h, esperado);
}

/**
 * Lê a chave-mestra do ambiente: SECRETS_KEY_FILE (preferido, arquivo fora do repositório)
 * ou SECRETS_KEY. Retorna null se nenhuma estiver definida.
 */
export function carregarMestra(env = process.env) {
  if (env.SECRETS_KEY_FILE) {
    let txt;
    try {
      txt = readFileSync(env.SECRETS_KEY_FILE, 'utf8');
    } catch (e) {
      throw new Error(`não consegui ler SECRETS_KEY_FILE (${e.code || e.message})`);
    }
    return validarMestra(txt);
  }
  if (env.SECRETS_KEY) return validarMestra(env.SECRETS_KEY);
  return null;
}
