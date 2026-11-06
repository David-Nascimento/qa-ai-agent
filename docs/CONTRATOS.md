# Contratos de dados

Estes são os formatos que a plataforma espera. Ao trazer dados de outro projeto, **converta para estes formatos** no servidor (`server/server.js`) ou na importação. Não mude as telas para aceitar formatos diferentes.

## Onde cada informação aparece

| Informação | Lugar único | Módulo |
|---|---|---|
| Resumo dos últimos 7 dias | Dashboard | `10-dashboard.js` |
| Pastas (projetos) e componentes, contagem por tecnologia | Pipelines | `20-pipelines.js` |
| Lista de execuções | Execuções › Histórico | `30-execucoes.js` |
| Esteiras rodando agora, cenário a cenário | Execuções › Ao vivo | `90-tempo-real.js` |
| Cenários de teste e último resultado | Cenários (lidos do Jira) | `40-cenarios.js` |
| Taxa de sucesso, falhas, MTTR, causa raiz, horário | Análises › Qualidade | `50-analises.js` |
| Tempo por plataforma, projeto e componente; auditoria e CSV | Análises › Tempo de execução | `51-analises-tempo.js` |
| Falhas por componente, meta, testes instáveis | Análises › Estabilidade | `50-analises.js` |

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
  url: 'https://.../browse/QA-101'
}
```

Resposta de `GET /api/jira/scenarios`:

```json
{ "scenarios": [ { "key": "QA-101", "name": "CT-001 Fluxo de compra completo", "status": "Pronto", "pipeline": "Checkout", "url": "https://.../browse/QA-101" } ] }
```

## Eventos em tempo real (SSE, `GET /events`)

| Evento | Campos |
|---|---|
| `build_start` | `job`, `build`, `timestamp`, `estimatedDuration`, `folder?`, `url`, `total?`, `scenarios?` |
| `scenario` | `job`, `build`, `name`, `status` (`pass`/`fail`/`run`), `duration` (s), `resp` (ms ou `null`), `elapsed` (s) |
| `stage` | `job`, `build`, `stage`, `status`, `duration` (ms) |
| `build_end` | `job`, `build`, `status` (`Sucesso`/`Falha`/`Cancelada`), `duration` (ms), `passed`, `failed`, `total`, `result` |
| `jira` | `job`, `build`, `scenario`, `key`, `action` (`create`/`comment`), `url` |

`job` pode ser o nome do componente (`Checkout`) ou o caminho no Jenkins (`E-commerce/Checkout`). A tela usa a última parte como nome do componente e guarda o caminho completo para disparar e parar builds. Componentes que ainda não existem são criados na pasta informada em `folder` (ou `Jenkins`).

## Rotas do servidor

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/health` | estado do servidor |
| GET | `/events` | eventos SSE |
| GET | `/api/state` | builds em acompanhamento |
| GET | `/api/jira/scenarios?jql=&field=` | cenários do Jira |
| POST | `/api/build` | `{ job, params? }` dispara build |
| POST | `/api/stop` | `{ job, build }` para build |
| POST | `/api/jira/bug` | `{ job, build, scenario, details? }` abre/comenta bug |

## Configuração da interface — `CFG` (`localStorage` `qa:cfg`)

| Chave | Padrão | Uso |
|---|---|---|
| `ai` | `false` | mostra os recursos de IA |
| `goal` | `95` | meta de taxa de sucesso (%) |
| `jql` | `project = QA AND issuetype = Test AND labels = automatizado ORDER BY key` | consulta dos cenários |
| `jiraField` | `components` | campo do Jira com o componente |
| `ws`, `lang`, `tz`, `ret`, `alerts`, `weekly` | — | preferências gerais |

## Variáveis do servidor

Todas estão em [`server/.env.example`](../server/.env.example). Jenkins: `JENKINS_URL`, `JENKINS_USER`, `JENKINS_TOKEN`, `JENKINS_JOBS`, `POLL_MS`, `DISCOVER_MS`, `LOG_REGEX`, `RESP_REGEX`. Jira: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_PROJECT`, `JIRA_API_VERSION`, `JIRA_SCENARIOS_JQL`, `JIRA_PIPELINE_FIELD`, `JIRA_AUTO_BUG`, `JIRA_ISSUE_TYPE`, `JIRA_LABELS`.
