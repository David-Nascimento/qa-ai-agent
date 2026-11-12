// Histórico de execuções finalizadas, gravado em arquivo JSON (sem banco e sem dependências).
// Guarda, por execução, os mesmos eventos que a tela já entende (build_start, scenario, build_end),
// então a tela reconstrói o histórico reaproveitando o caminho do tempo real.
// Escrita atômica (arquivo temporário + rename), permissão 600 e recuperação de arquivo corrompido.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CFG, log } from './config.js';

const H = CFG.history;
const runs = []; // finalizadas, da mais antiga para a mais nova
const pending = new Map(); // "job#build" → { start, scen: Map }
const keyOf = d => `${d.job}#${d.build}`;
let timer = null;
let dirty = false;

export const historyOn = () => !!H.file && !CFG.demo;

export function loadHistory() {
  if (!historyOn() || !existsSync(H.file)) return;
  try {
    const arr = JSON.parse(readFileSync(H.file, 'utf8'));
    if (!Array.isArray(arr)) throw new Error('formato inesperado');
    runs.push(...arr.filter(r => r && r.start && r.end).slice(-H.max));
    log(`Histórico: ${runs.length} execuções carregadas de ${H.file}`);
  } catch (e) {
    const ruim = `${H.file}.corrompido-${Date.now()}`;
    try {
      renameSync(H.file, ruim);
    } catch {
      /* sem permissão: segue vazio */
    }
    log(`Histórico ilegível (${e.message}); guardei uma cópia em ${ruim} e comecei vazio`);
  }
}

export function flushHistory() {
  clearTimeout(timer);
  timer = null;
  if (!dirty || !historyOn()) return;
  dirty = false;
  try {
    mkdirSync(dirname(H.file), { recursive: true, mode: 0o700 });
    const tmp = H.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(runs), { mode: 0o600 });
    renameSync(tmp, H.file);
    chmodSync(H.file, 0o600);
  } catch (e) {
    dirty = true;
    log(`Histórico: não consegui gravar (${e.code || e.message})`);
  }
}

function saveSoon() {
  dirty = true;
  if (!timer) timer = setTimeout(flushHistory, 1000).unref();
}

// chamado por emit(): acompanha o ciclo de cada execução e arquiva quando ela termina
export function observe(type, d) {
  if (!historyOn() || !d || d.job === undefined) return;
  const k = keyOf(d);
  if (type === 'build_start') {
    if (pending.size > 500) pending.clear();
    pending.set(k, { start: d, scen: new Map() });
  } else if (type === 'scenario') {
    pending.get(k)?.scen.set(d.name, d);
  } else if (type === 'build_end') {
    const p = pending.get(k);
    if (!p) return;
    pending.delete(k);
    // um re-run mantém o mesmo número: a execução nova substitui a antiga
    const i = runs.findIndex(r => keyOf(r.start) === k);
    if (i >= 0) runs.splice(i, 1);
    runs.push({ start: p.start, scenarios: [...p.scen.values()], end: d });
    if (runs.length > H.max) runs.splice(0, runs.length - H.max);
    saveSoon();
  }
}

export const listHistory = (limit = 1000) => runs.slice(-Math.max(1, Math.min(limit, H.max)));
