#!/usr/bin/env node
// CLI para proteger credenciais. Uso:
//   node segredos.js gerar-chave [arquivo]     gera a chave-mestra (grava em arquivo com permissão 600)
//   node segredos.js cifrar                    lê o segredo do stdin e imprime enc:v1:...
//   node segredos.js hash-chave                lê a chave de API do stdin e imprime scrypt:v1:...
//   node segredos.js verificar                 confere se o .env decifra com a chave-mestra atual
// A chave-mestra vem de SECRETS_KEY_FILE (preferido) ou SECRETS_KEY. Nada é gravado em histórico:
// o segredo entra pelo stdin, nunca como argumento de linha de comando.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { abrir, carregarMestra, conferirChave, ehHash, estaSelado, gerarChave, hashChave, selar } from './cripto.js';

const [, , cmd, arg] = process.argv;
const falha = m => {
  console.error('erro: ' + m);
  process.exit(1);
};

async function stdin() {
  if (process.stdin.isTTY) falha('envie o segredo pelo stdin (ex.: printf %s "$TOKEN" | node segredos.js cifrar)');
  let t = '';
  for await (const c of process.stdin) t += c;
  t = t.replace(/\r?\n$/, '');
  if (!t) falha('segredo vazio');
  return t;
}

function mestra() {
  try {
    const m = carregarMestra();
    if (!m) falha('defina SECRETS_KEY_FILE (ou SECRETS_KEY). Gere uma com: node segredos.js gerar-chave segredos.key');
    return m;
  } catch (e) {
    return falha(e.message);
  }
}

if (cmd === 'gerar-chave') {
  const k = gerarChave();
  if (!arg) {
    console.log(k);
  } else {
    if (existsSync(arg)) falha(`${arg} já existe; não vou sobrescrever uma chave-mestra`);
    writeFileSync(arg, k + '\n', { mode: 0o600 });
    console.log(
      `chave gravada em ${arg} (permissão 600). Guarde um backup fora do repositório; sem ela os valores cifrados não abrem.`
    );
  }
} else if (cmd === 'cifrar') {
  console.log(selar(await stdin(), mestra()));
} else if (cmd === 'hash-chave') {
  console.log(hashChave(await stdin()));
} else if (cmd === 'verificar') {
  const arquivo = arg || '.env';
  if (!existsSync(arquivo)) falha(`${arquivo} não encontrado`);
  const m = mestra();
  let ok = 0;
  let ruim = 0;
  for (const linha of readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const mm = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linha);
    if (!mm) continue;
    const [, nome, bruto] = mm;
    const v = bruto.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (estaSelado(v)) {
      try {
        abrir(v, m);
        ok++;
        console.log(`ok       ${nome} (cifrado)`);
      } catch (e) {
        ruim++;
        console.log(`FALHOU   ${nome}: ${e.message}`);
      }
    } else if (ehHash(v)) {
      ok++;
      console.log(`ok       ${nome} (hash)`);
    } else if (/(TOKEN|PASSWORD|SENHA|SECRET|API_KEY)$/.test(nome) && v) {
      ruim++;
      console.log(`EM CLARO ${nome}: cifre com "segredos.js cifrar" (ou hash-chave para API_KEY)`);
    }
  }
  console.log(`\n${ok} protegidos, ${ruim} com problema`);
  process.exit(ruim ? 1 : 0);
} else if (cmd === 'conferir') {
  // uso interno de teste: conferir <hash> com a chave no stdin
  console.log(conferirChave(await stdin(), arg) ? 'ok' : 'não confere');
} else {
  console.log('uso: node segredos.js <gerar-chave [arquivo] | cifrar | hash-chave | verificar [.env]>');
  process.exit(cmd ? 1 : 0);
}
