# Guia de migração: projeto antigo → QA AI Agent

Este guia serve para pedir a um agente (Antigravity ou outro) que traga as informações e integrações do projeto antigo para este. A ideia é que ele **adapte** o que existe lá aos formatos daqui, em vez de sobrescrever arquivos.

## Antes de começar

1. **Abra os dois projetos no mesmo workspace** do Antigravity: este repositório (`qa-ai-agent`, o **destino**) e o projeto antigo (a **origem**). As regras deste repositório ficam em `AGENTS.md` e `.agents/rules/`, e o Antigravity as carrega sozinho.
2. **Crie uma branch** no destino:
   ```bash
   git checkout -b migracao/projeto-antigo
   ```
3. **Não coloque tokens no código.** As credenciais do projeto antigo vão para `server/.env` (que não vai para o Git), seguindo `server/.env.example`.

## Como pedir ao agente

Cole o texto abaixo no Antigravity, trocando o caminho da origem:

```text
Quero migrar o projeto antigo (pasta: <CAMINHO_DO_PROJETO_ANTIGO>) para este repositório qa-ai-agent.
Siga AGENTS.md, .agents/rules/migracao.md e docs/CONTRATOS.md.

Etapa 1 — Inventário (não altere código ainda):
- Liste o que o projeto antigo faz: chamadas à API do Jira (endpoints, JQL, campos), chamadas à API do Jenkins,
  telas, métricas, configurações e dados.
- Para cada item, diga onde ele já existe aqui (módulo e função) ou onde deve entrar, usando a tabela
  "Onde cada informação aparece" de docs/CONTRATOS.md.
- Aponte as diferenças de formato entre os dados de lá e os contratos daqui.
- Salve tudo em docs/migracao/inventario.md e me mostre antes de seguir.

Etapa 2 — Migração, depois que eu aprovar o inventário:
- Um commit por item.
- Chamadas ao Jira e ao Jenkins entram só em server/server.js, convertendo para os contratos.
- Na interface, amplie o módulo dono da informação. Não crie telas que repitam o que já existe.
- Configurações e segredos novos entram em server/.env.example (sem valores reais).
- Não ative nem adicione nada de IA.
- Ao fim de cada item, rode `cd server && npm test` e confira as telas no navegador, sem erros no console.
```

## O que o agente deve entregar

- `docs/migracao/inventario.md` com a tabela **origem → destino**.
- Commits pequenos na branch `migracao/...`.
- Testes do servidor passando e a seção do `README.md` atualizada para cada funcionalidade migrada.

## Mapa rápido de conceitos

| No projeto antigo (exemplos) | Aqui |
|---|---|
| Busca de cenários/casos de teste no Jira | `jiraScenarios()` em `server/server.js` → `GET /api/jira/scenarios` → tela Cenários |
| Consulta (JQL), filtro salvo ou board | `JIRA_SCENARIOS_JQL`, ou uma função nova ao lado de `jiraScenarios()` que devolva o mesmo formato |
| Campo que diz a qual sistema/pipeline o teste pertence | `JIRA_PIPELINE_FIELD` (`components`, `labels` ou `customfield_x`) |
| Jobs do Jenkins | `JENKINS_JOBS` (com pastas: `Pasta/Job`) |
| Resultado dos testes por build | log progressivo + `testReport` → eventos `scenario` e `build_end` |
| Lista de projetos/sistemas | pastas (`group`) dos componentes em Pipelines |
| Tipo de teste (API, app, web) | `tech`: `API`, `Mobile` ou `Web` |
| Relatórios de tempo | Análises › Tempo de execução (com CSV) |

## Como evitar conflitos

- **Arquivos pequenos por tela.** O código da interface está separado em `assets/js/NN-*.js`, então cada funcionalidade migrada mexe em poucos arquivos.
- **Finais de linha e formatação padronizados** por `.gitattributes`, `.editorconfig` e `.prettierrc.json`. Formate só os arquivos alterados.
- **Contratos estáveis.** O agente converte os dados antigos para o formato daqui, em vez de mudar o formato daqui.
- **Nada de reescrever arquivos inteiros.** As alterações devem ser pontuais, dentro do módulo certo.
- **Merge frequente:** depois de cada item, `git pull --rebase` na branch antes de continuar.
