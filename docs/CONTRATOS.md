# Contratos de dados

Estes são os formatos que a plataforma espera. Ao trazer dados de outro projeto, **converta para estes formatos** no servidor (módulo da fonte em `server/`) ou na importação. Não mude as telas para aceitar formatos diferentes.

## Onde cada informação aparece

| Informação                                                          | Lugar único                       | Módulo                 |
| ------------------------------------------------------------------- | --------------------------------- | ---------------------- |
| Resumo dos últimos 7 dias                                           | Dashboard                         | `10-dashboard.js`      |
| Pastas (projetos) e componentes, contagem por tecnologia            | Pipelines                         | `20-pipelines.js`      |
| Lista de execuções                                                  | Execuções › Histórico             | `30-execucoes.js`      |
| Esteiras rodando agora, cenário a cenário                           | Execuções › Ao vivo               | `90-tempo-real.js`     |
| Cenários de teste e último resultado                                | Cenários (lidos do Jira)          | `40-cenarios.js`       |
| Ciclos de teste (Zephyr Scale) e resultado de cada cenário no ciclo | Cenários (filtro e coluna Ciclos) | `40-cenarios.js`       |
| Cards do Jira atribuídos ao dono do token                           | Meus cards                        | `41-meus-cards.js`     |
| Taxa de sucesso, falhas, MTTR, causa raiz, horário                  | Análises › Qualidade              | `50-analises.js`       |
| Tempo por plataforma, projeto e componente; auditoria e CSV         | Análises › Tempo de execução      | `51-analises-tempo.js` |
| Falhas por componente, meta, testes instáveis                       | Análises › Estabilidade           | `50-analises.js`       |

## Componente (pipeline) — `PIPES`

```js
{
  name: 'Checkout',          // nome único do componente (= job no Jenkins, sem a pasta)
  group: 'E-commerce',       // pasta / projeto
  tech: 'Mobile',            // 'API' | 'Mobile' | 'Web'
  ico: 'box',                // 'box' | 'user' | 'search' | 'lock'
  rate: 91.2,                // taxa de sucesso de referência (%), usada sem histórico
  dur: 542,                  // duração média de referência (s), usada sem histórico
  scen: 15,                  // nº de cenários da suíte
  active: true               // opcional; false tira o componente das métricas de tempo
}
```

## Execução — `RUNS`

```js
{
  id: 10432,                 // número do build
  p: 'Checkout',             // componente (PIPES.name)
  s: 'Falha',                // 'Sucesso' | 'Falha' | 'Executando' | 'Cancelada'
  ok: 12, t: 15,             // cenários aprovados / total
  d: 558,                    // duração (s)
  at: new Date(),            // início
  live: { sc: [ { n, st, dur, resp } ], el, ext }  // só enquanto roda (Ao vivo)
}
```

A lista fica **da mais recente para a mais antiga**. As métricas de Análises usam só execuções `Sucesso` e `Falha`.

## Cenário — `SCENS` (vindo do Jira)

```js
{
  key: 'QA-101',             // chave da issue no Jira
  id: 'CT-001',              // ID do cenário; liga a issue às linhas do log do Jenkins
  name: 'Fluxo de compra completo',
  p: 'Checkout',             // componente (vem do campo JIRA_PIPELINE_FIELD)
  js: 'Pronto',              // status da issue no Jira
  url: 'https://.../browse/QA-101',
  case: 'QA-T1',             // chave do caso no Zephyr Scale (opcional; liga o cenário aos ciclos)
  cycles: [ { key: 'QA-R1', name: 'Regressão Sprint 42', status: 'pass' } ]  // ciclos em que aparece
}
```

Resposta de `GET /api/jira/scenarios`:

```json
{
  "scenarios": [
    {
      "key": "QA-101",
      "name": "CT-001 Fluxo de compra completo",
      "status": "Pronto",
      "pipeline": "Checkout",
      "caseKey": "QA-T1",
      "url": "https://.../browse/QA-101"
    }
  ]
}
```

## Ciclos de teste (Zephyr Scale Server/Data Center)

O servidor sincroniza o Jira sozinho (a cada `JIRA_SYNC_MS`) e guarda tudo em cache. A tela **não chama o Jira**: lê o cache em `GET /api/jira/state` e é avisada pelo evento `jira_sync`.

```json
{
  "syncedAt": 1762700000000,
  "error": null,
  "jql": "project = QA AND issuetype = Test ORDER BY key",
  "field": "components",
  "zephyr": true,
  "scenarios": [
    {
      "key": "QA-101",
      "name": "...",
      "status": "Pronto",
      "pipeline": "Checkout",
      "caseKey": "QA-T1",
      "url": "...",
      "cycles": [{ "key": "QA-R1", "name": "Regressão Sprint 42", "status": "pass" }]
    }
  ],
  "cycles": [
    {
      "key": "QA-R1",
      "name": "Regressão Sprint 42",
      "status": "In Progress",
      "folder": "/Regressão",
      "updated": "2026-11-08T10:00:00Z",
      "url": "https://.../secure/Tests.jspa#/testPlayer/QA-R1",
      "totals": { "total": 3, "pass": 1, "fail": 1, "blocked": 0, "run": 0, "pend": 1, "unlinked": 1 }
    }
  ]
}
```

- Resultado de um caso: `pass` · `fail` · `blocked` · `run` · `pend` (Pass, Fail, Blocked, In Progress, Not Executed no Zephyr).
- `unlinked` = casos do ciclo que não têm cenário entre os carregados.
- A **chave do caso** (`PROJ-T123`) é lida do campo `ZEPHYR_CASE_FIELD` da issue do cenário ou, se vazio, do título e dos labels. É ela que liga o cenário ao ciclo.
- Os ciclos ficam fora do contrato dos cenários antigos: sem `ZEPHYR=true`, `cycles` vem vazio e a tela não mostra a coluna.

**Chamadas feitas ao Zephyr** (API ATM do Server/Data Center, no endereço do Jira, com a autenticação do Jira; prefixo configurável em `ZEPHYR_API_PATH`):

| Chamada                                                                  | Uso                                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `GET /rest/atm/1.0/testrun/search?query=…&fields=…&startAt=&maxResults=` | lista os ciclos (TQL em `ZEPHYR_TQL`; padrão `projectKey = "<JIRA_PROJECT>"`) |
| `GET /rest/atm/1.0/testrun/{chave}`                                      | itens do ciclo: `items[].testCaseKey` e `items[].status`                      |

> **Confirme no seu ambiente.** Estes caminhos e o formato das respostas foram escritos a partir da API ATM do Zephyr Scale Server/DC, mas não foram testados contra um Jira real (os testes usam um Jira falso). Se a resposta for diferente, o ajuste é só em `zephyrList()` e `zephyrItems()`, em `server/server.js`.

## Eventos em tempo real (SSE, `GET /events`)

| Evento        | Campos                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_start` | `job`, `build`, `timestamp`, `estimatedDuration?`, `folder?`, `url`, `total?`, `scenarios?`, `name?` (nome do componente; no GitHub, o do workflow), `source?` (`Jenkins` ou `GitHub Actions`; sem ele, Jenkins), `branch?` |
| `scenario`    | `job`, `build`, `name`, `status` (`pass`/`fail`/`run`), `duration` (s), `resp` (ms ou `null`), `elapsed` (s)                                                                                                                |
| `stage`       | `job`, `build`, `stage`, `status`, `duration` (ms)                                                                                                                                                                          |
| `build_end`   | `job`, `build`, `status` (`Sucesso`/`Falha`/`Cancelada`), `duration` (ms), `passed`, `failed`, `total`, `result`, `source?`                                                                                                 |
| `jira`        | `job`, `build`, `scenario`, `key`, `action` (`create`/`comment`), `url`                                                                                                                                                     |
| `jira_sync`   | `at` (ms), `error` (texto ou `null`), `changed` (quantidade). Só para quem está conectado, não entra no reenvio dos últimos eventos. Avisa que o cache do Jira mudou.                                                       |

`job` pode ser o nome do componente (`Checkout`) ou o caminho no Jenkins (`E-commerce/Checkout`). Para disparar e parar, o job precisa estar em `JENKINS_JOBS`. A tela usa a última parte como nome do componente e guarda o caminho completo para disparar e parar builds. Componentes que ainda não existem são criados na pasta informada em `folder` (ou `Jenkins`).

### GitHub Actions nos mesmos eventos

O servidor traduz o GitHub Actions para o contrato do Jenkins, então a tela não tem código separado por fonte:

| Jenkins              | GitHub Actions                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| pasta (`folder`)     | repositório (`dono/repo`)                                                                                       |
| job (`job`)          | workflow: `dono/repo/arquivo.yml`; o nome do componente vem em `name`                                           |
| build (`build`)      | `run_number` do run                                                                                             |
| estágio (`stage`)    | job do workflow; `status` no formato do Jenkins (`IN_PROGRESS`, `SUCCESS`, `FAILED`, `ABORTED`, `NOT_EXECUTED`) |
| cenário (`scenario`) | linha de resultado no log do job (mesmos formatos e `LOG_REGEX`; o carimbo de hora do GitHub é removido)        |

Diferenças que vêm da API do GitHub:

- O log de um job só fica disponível **depois que o job termina**. Por isso os eventos `scenario` chegam por job concluído e não linha a linha. Enquanto isso, os estágios mostram o andamento.
- Um _re-run_ do mesmo run mantém o mesmo `run_number` e não aparece como execução nova na tela.
- Sem linhas de resultado no log, `passed`, `failed` e `total` ficam em 0 (o status do run continua valendo).

## Rotas do servidor

| Método | Rota                              | Uso                                                                                                                                                                                                                                                                                                       |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                     | estado do servidor: `jenkins`, `github` e `jira` (configurados ou não), `workflows`, `githubRate` (`limit`, `remaining`, `reset`), `jiraSync` (`at`, `error`), `secure` (a requisição chegou por canal criptografado) e `slow` (fator de lentidão por limite de `jenkins`, `jira` e `github`, 1 = normal) |
| GET    | `/api/integrations`               | estado das integrações `jenkins`, `github` e `jira`: `{ edit: { ok, reason }, items: { k: { configured, source: 'env' \| 'ui' \| null, tokenSet, …campos públicos } } }`. **Nunca contém o token**                                                                                                        |
| PUT    | `/api/integrations/{k}`           | salva a integração: valida, **testa a conexão**, grava o token cifrado e aplica na hora. Erros: `400` com `errors` por campo, `422` conexão recusada (com `errors`), `409` sem permissão de edição ou integração do `.env`. Sem `token` no corpo, reaproveita o salvo só se o endereço não mudou          |
| POST   | `/api/integrations/{k}/test`      | testa sem salvar (corpo com os campos do formulário); corpo vazio testa a configuração atual                                                                                                                                                                                                              |
| DELETE | `/api/integrations/{k}`           | apaga a integração salva (e o token)                                                                                                                                                                                                                                                                      |
| POST   | `/api/ticket`                     | gera um **tíquete de uso único** (`{ ticket, expiresInMs }`, padrão 30 s) para abrir o SSE sem pôr a chave na URL; exige a chave no cabeçalho                                                                                                                                                             |
| GET    | `/events`                         | eventos SSE; autentica com `x-api-key` ou `?ticket=` (o `?key=` só com `ALLOW_URL_KEY=true`)                                                                                                                                                                                                              |
| GET    | `/api/history?limit=`             | execuções finalizadas gravadas pelo servidor (mais antigas primeiro, até `HISTORY_MAX`). Cada item: `{ start, scenarios[], end }`, com os mesmos campos dos eventos `build_start`, `scenario` e `build_end`                                                                                               |
| GET    | `/api/state`                      | builds em acompanhamento                                                                                                                                                                                                                                                                                  |
| GET    | `/api/jira/scenarios?jql=&field=` | cenários do Jira (consulta na hora; `jql` presa ao `JIRA_PROJECT`, `400` se `jql`/`field` inválidos)                                                                                                                                                                                                                                             |
| GET    | `/api/jira/mine?refresh=`         | cards atribuídos ao dono do token (`me`, `cards[]` com `key`, `summary`, `status`, `category` = `new`/`indeterminate`/`done`, `priority`, `type`, `updated`, `due`, `resolved`, `url`; `at`, `days`, `cached`). Cache de `JIRA_MINE_TTL_MS`; `refresh=1` limitado a 1 a cada 5 s. `400` se o Jira não estiver configurado |
| GET    | `/api/jira/state`                 | cenários e ciclos em cache (não chama o Jira)                                                                                                                                                                                                                                                             |
| POST   | `/api/jira/sync`                  | atualização manual; no máximo 1 a cada `JIRA_MIN_MANUAL_MS`, antes disso devolve o cache com `throttled: true`                                                                                                                                                                                            |
| POST   | `/api/build`                      | `{ job, params? }` dispara build. No GitHub, o workflow precisa de `on: workflow_dispatch`; `params.ref` escolhe a branch (padrão: a do repositório) e os demais `params` viram `inputs`                                                                                                                  |
| POST   | `/api/stop`                       | `{ job, build }` para build (no GitHub, cancela o run; só funciona para runs em acompanhamento)                                                                                                                                                                                                           |
| POST   | `/api/jira/bug`                   | `{ job, build, scenario, details? }` abre/comenta bug                                                                                                                                                                                                                                                     |

Erros das rotas: `400` corpo inválido ou `build` não numérico, `401` chave da API ausente, errada ou tíquete já usado/expirado, `403` job fora de `JENKINS_JOBS`, `413` corpo grande demais, `429` muitas chaves inválidas do mesmo IP (com `Retry-After`), `503` limite de conexões SSE e `502` falha ao falar com Jenkins, GitHub ou Jira.

## Configuração da interface — `CFG` (`localStorage` `qa:cfg`)

| Chave                                         | Padrão                                                                     | Uso                            |
| --------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| `ai`                                          | `false`                                                                    | mostra os recursos de IA       |
| `goal`                                        | `95`                                                                       | meta de taxa de sucesso (%)    |
| `jql`                                         | `project = QA AND issuetype = Test AND labels = automatizado ORDER BY key` | consulta dos cenários          |
| `jiraField`                                   | `components`                                                               | campo do Jira com o componente |
| `ws`, `lang`, `tz`, `ret`, `alerts`, `weekly` | —                                                                          | preferências gerais            |

## Variáveis do servidor

Todas estão em [`server/.env.example`](../server/.env.example). Jenkins: `JENKINS_URL`, `JENKINS_USER`, `JENKINS_TOKEN`, `JENKINS_JOBS`, `POLL_MS`, `DISCOVER_MS`, `LOG_REGEX`, `RESP_REGEX`. GitHub Actions: `GITHUB_TOKEN`, `GITHUB_API_URL`, `GITHUB_WORKFLOWS`, `GITHUB_POLL_MS`, `GITHUB_DISCOVER_MS`, `GITHUB_LOG_JOBS`. Jira: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_PROJECT`, `JIRA_API_VERSION`, `JIRA_SCENARIOS_JQL`, `JIRA_PIPELINE_FIELD`, `JIRA_AUTO_BUG`, `JIRA_ISSUE_TYPE`, `JIRA_LABELS`, `JIRA_AUTH`. Sincronização: `JIRA_SYNC_MS`, `JIRA_FULL_SYNC_MS`, `JIRA_AFTER_BUILD_MS`, `JIRA_GAP_MS`, `JIRA_MIN_MANUAL_MS`. Zephyr Scale: `ZEPHYR`, `ZEPHYR_API_PATH`, `ZEPHYR_TQL`, `ZEPHYR_CASE_FIELD`, `ZEPHYR_MAX_CYCLES`, `ZEPHYR_ACTIVE_DAYS`, `ZEPHYR_CLOSED_STATUS`, `ZEPHYR_CYCLE_URL`. Limite de requisições: `HTTP_RETRIES`, `HTTP_BACKOFF_MS`, `HTTP_MAX_WAIT_MS`, `STAGES_EVERY`, `TRACK_MAX_ERRORS`, `MAX_TRACKED_BUILDS`.
