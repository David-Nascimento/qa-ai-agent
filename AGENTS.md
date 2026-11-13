# AGENTS.md — QA AI Agent

Instruções para agentes de código (Antigravity, Claude Code, Copilot e outros) que trabalham neste repositório. Leia antes de alterar qualquer arquivo.

## O que é o projeto

Plataforma para acompanhar **pipelines e cenários de teste** com dados do **Jenkins**, do **GitHub Actions** e do **Jira**, todos lidos **pela API REST**. Ela tem métricas, análises e acompanhamento em tempo real.

- **Interface:** HTML, CSS e JavaScript puros, **sem build e sem framework**. Os scripts são clássicos e carregados em ordem pelo `index.html`.
- **Servidor:** Node.js 20.6+ **sem dependências** (`server/*.js`, entrada em `server/server.js`). Ele consulta o Jenkins, o GitHub Actions e o Jira e envia eventos para a tela por **Server-Sent Events**.
- **Idioma:** todo texto visível ao usuário é em **português do Brasil**.
- **IA:** existe um Agente de QA, mas ele fica **desligado por padrão** (Configurações › Geral › *Recursos de IA*). A fase atual é **só Jenkins, GitHub Actions e Jira**. Não adicione integrações com modelos de IA.

## Estrutura

```
index.html                    marcação das telas + ordem de carga dos scripts
assets/css/NN-*.css            estilos por área (a ordem dos <link> no index.html importa); tokens em 00-base.css
assets/js/00-base.js          utilitários ($, esc, fmtDur, store), ícones, menu
assets/js/01-dados.js         dados de exemplo: PIPES, RUNS, SCENS, SUITE
assets/js/10-dashboard.js     Dashboard (sempre os últimos 7 dias)
assets/js/20-pipelines.js     Pipelines: pastas (projetos) e componentes
assets/js/30-execucoes.js     Execuções › Histórico, Importar JSON
assets/js/31-detalhe.js       Detalhe da execução
assets/js/40-cenarios.js      Cenários lidos do Jira
assets/js/50-analises.js      Análises › Qualidade e Estabilidade (filtro de período)
assets/js/51-analises-tempo.js Análises › Tempo de execução (auditoria, CSV)
assets/js/60-integracoes.js   Integrações
assets/js/70-configuracoes.js Configurações (CFG, interruptor de IA)
assets/js/80-navegacao.js     rotas por hash
assets/js/81-acoes.js         modais, menus, toasts, ações globais
assets/js/90-tempo-real.js    Execuções › Ao vivo (simulação e cards)
assets/js/91-conexao-servidor.js modo conectado (?api=): eventos SSE
assets/js/95-agente-ia.js     Agente de QA (só com IA ligada)
assets/js/99-inicio.js        inicialização
server/server.js              entrada: rotas /api, SSE, TLS
server/config.js · http.js · eventos.js · web.js    configuração, HTTP com retentativa, SSE, autenticação
server/jenkins.js · github.js · jira.js · demo.js   uma fonte por arquivo
server/historico.js           histórico de execuções em arquivo (server/data, fora do git)
server/integracoes.js         cofre das integrações salvas pela tela: valida, testa, cifra o token (só de escrita)
assets/js/62-integracoes-form.js   formulários de integração e token só de escrita
server/test/*.test.js         testes com Jenkins, GitHub e Jira falsos
server/cripto.js              AES-256-GCM + scrypt (segredos cifrados, hash da chave da API)
server/segredos.js            CLI: gerar-chave, cifrar, hash-chave, verificar
server/scripts/verificar-segredos.mjs   varredura de segredos nos arquivos versionados (`npm run check:secrets`)
docs/MIGRACAO.md              guia para trazer o projeto antigo para cá
docs/CONTRATOS.md             formatos de dados e eventos (o "contrato")
docs/MAPA.md                  guia do Mapa de funcionalidades e do Canvas de ligações
docs/mapa/                    gerar_docs.py (gera o Mapa e o Canvas) · PROMPT.md · os dois HTML gerados
mapa.config.json              regras de negócio, fórmulas, diagramas e nós do Canvas (conteúdo escrito à mão)
docs/SSO.md                   proposta de login com SSO e permissões (ainda não implementada)
docs/prototipos/sso/          protótipos HTML estáticos das telas de login e permissões
```

## Regras

1. **Os scripts compartilham o escopo global e a ordem importa.** Um arquivo só pode *executar na carga* funções e variáveis de arquivos com número menor. Dentro de funções (executadas depois), qualquer módulo pode ser usado.
2. **Um lugar para cada informação.** Antes de criar algo novo, veja em `docs/CONTRATOS.md` › *Onde cada informação aparece*. Não crie telas nem blocos que repitam métricas existentes; amplie o módulo dono da informação.
3. **Credenciais só no servidor.** O navegador nunca chama o Jenkins, o GitHub nem o Jira diretamente. Chamadas novas entram no módulo da fonte (`server/jenkins.js`, `github.js` ou `jira.js`), perto de `jenkinsJson()`, `ghJson()`, `jira()` e `jiraScenarios()`; as rotas ficam em `server/server.js`, e chegam à tela pelas rotas `/api/*` ou pelos eventos SSE.
4. **Segurança é requisito.** Nenhum segredo em texto puro no código, no front, em log ou em teste (use valores fictícios). Tokens novos entram pelo helper `sec()` (aceita `enc:v1:`), URLs com credencial passam por `requireHttps()`, e qualquer texto que possa conter segredo vai por `redact()`/`log()`. O front não tem script inline (CSP) e não guarda credenciais. Dados só entram por canal criptografado: `secureTransport()` em `web.js` barra com `403 tls_required` o que não vier por HTTPS (ou loopback). Rode `npm run check:secrets` e `npm test` antes de commitar. Veja README › Segurança.
5. **Respeite os contratos** de `docs/CONTRATOS.md`: formato de pipeline, execução, cenário, eventos SSE e respostas das rotas. Se um dado do projeto antigo tiver outro formato, **converta no servidor** para o formato do contrato. Não mude a tela para aceitar o formato antigo.
6. **Não renomeie** IDs de elementos, nomes de funções nem chaves do `localStorage` (`qa:pipes2`, `qa:scens`, `qa:ints`, `qa:cfg`, `qa:jiraSync`) sem atualizar todos os usos.
7. **IA atrás do interruptor.** Qualquer elemento de IA leva a classe `ai-only` (ou `data-ask`/`data-ask-run`) e só funciona com `CFG.ai === true`.
8. **Estilo:** use os tokens de cor do `:root`, sem cores soltas. Siga o `.prettierrc.json` (`npx prettier --write`) só nos arquivos que você alterou. Não reformate arquivos que você não tocou.
9. **Mapa e Canvas em dia.** Os dois HTML em `docs/mapa/` são **gerados**: não edite à mão. Ao criar ou mudar uma regra de negócio, uma fórmula ou um nó, edite `mapa.config.json` e rode `python3 docs/mapa/gerar_docs.py`. Ao renomear uma função citada, o script falha dizendo qual referência corrigir. Commite o config e os HTML gerados juntos.
10. **Mudanças pequenas:** um commit por funcionalidade, numa branch própria (por exemplo `migracao/cenarios-jira`).

## Como verificar

```bash
cd server && npm test                                     # testes do servidor (Jenkins, GitHub e Jira falsos)
python3 -m http.server 8080                               # abra http://localhost:8080 e confira o console (sem erros)
cd server && npm run demo                                 # servidor em modo demonstração
# abra http://localhost:8080/index.html?api=http://localhost:3000#aovivo
```

Ao terminar, confira as telas que você alterou com **Recursos de IA desligado** (padrão) e atualize a seção correspondente do `README.md`.
