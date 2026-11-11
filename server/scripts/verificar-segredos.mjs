#!/usr/bin/env node
// Procura segredos nos arquivos versionados (git ls-files). Use antes de cada commit/PR: `npm run check:secrets`.
// Sai com código 1 se achar algo. Para um falso positivo, ponha "segredo-ok" na mesma linha.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const inicio = process.argv[2] || process.cwd();
const REGRAS = [
  ['token do GitHub', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['chave privada', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['chave de acesso AWS', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['token de API Atlassian', /\bATATT[A-Za-z0-9_=-]{20,}/],
  ['credencial na URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{3,}@[^\s'"]+/i],
  ['cabeçalho Authorization fixo', /Authorization['"]?\s*[:=]\s*['"](?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}['"]/i],
  [
    'segredo atribuído em texto puro',
    /\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SENHA|SECRET|API_KEY)\s*=\s*(?!enc:v1:|scrypt:v1:|\s*$|["']?\s*$|["']?(?:seu|sua|your|exemplo|example|changeme|xxx|\.\.\.|<|\$\{))[^\s#'"]{8,}/,
  ],
];
const IGNORAR_ARQ = /(^|\/)(package-lock\.json|.*\.(png|jpe?g|gif|ico|woff2?|pdf))$/i;

let raiz, arquivos;
try {
  // sempre a partir da raiz do repositório, mesmo se executado de dentro de server/
  raiz = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: inicio, encoding: 'utf8' }).trim();
  arquivos = execFileSync('git', ['ls-files', '-z'], { cwd: raiz, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  console.error('erro: execute dentro de um repositório git');
  process.exit(2);
}
const achados = [];
for (const f of arquivos) {
  if (IGNORAR_ARQ.test(f)) continue;
  const p = join(raiz, f);
  let txt;
  try {
    if (statSync(p).size > 2e6) continue;
    txt = readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  if (txt.includes('\0')) continue;
  txt.split(/\r?\n/).forEach((linha, i) => {
    if (linha.includes('segredo-ok')) return;
    for (const [nome, rx] of REGRAS) if (rx.test(linha)) achados.push(`${f}:${i + 1}  ${nome}`);
  });
}
if (achados.length) {
  console.error(`Possíveis segredos versionados (${achados.length}):\n  ` + achados.join('\n  '));
  console.error('\nRemova o valor, REVOGUE a credencial (ela já pode ter vazado) e use .env cifrado.');
  process.exit(1);
}
console.log(`ok: nenhum segredo em ${arquivos.length} arquivos versionados`);
