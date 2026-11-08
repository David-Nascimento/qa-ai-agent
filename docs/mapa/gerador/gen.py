"""Gera o canvas de ligações do QA AI Agent a partir do código real do repositório.

Uso (na raiz do projeto):
  python3 docs/mapa/gerador/gen.py . docs/mapa/mapa-funcionalidades.html docs/mapa/canvas-ligacoes.html docs/mapa/gerador/template.html --completo

Lê as funções direto de assets/js/*.js e server/server.js e os textos das regras (RN-*) do Mapa.
Se uma função citada mudar de nome, o script para com erro e diz qual.
"""
import json, re, sys, html

REPO = sys.argv[1]
MAPA = sys.argv[2]
OUT = sys.argv[3]

def read(p):
    return open(f'{REPO}/{p}', encoding='utf-8').read()

def block_from(src, start):
    """Do índice start até fechar as chaves do primeiro bloco."""
    i = src.index('{', start)
    depth = 0
    j = i
    in_str = None
    while j < len(src):
        c = src[j]
        if in_str:
            if c == '\\':
                j += 2
                continue
            if c == in_str:
                in_str = None
        elif c in '\'"`':
            in_str = c
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                end = j + 1
                if src[end:end + 2] == ')(' or src[end:end + 1] in ');':
                    k = src.find('\n', end)
                    end = k if k > 0 else end
                return src[start:end].rstrip()
        j += 1
    raise ValueError('bloco sem fim')

def fn(path, name):
    src = read(path)
    m = re.search(rf'(async )?function {name}\(', src)
    if m:
        start = src.rfind('\n', 0, m.start()) + 1
        i = src.index('(', m.start()); depth = 0
        while True:
            depth += {'(': 1, ')': -1}.get(src[i], 0)
            if depth == 0: break
            i += 1
        body = block_from(src, i)
        return src[start:i] + body
    m = re.search(rf'const {name} =', src)
    if m:
        start = src.rfind('\n', 0, m.start()) + 1
        arrow = src.index('=>', m.start())
        rest = src[arrow + 2:].lstrip()
        if rest.startswith('{'):
            return block_from(src, start)
        end = start
        while True:
            e = src.index('\n', end)
            line = src[end:e]
            end = e + 1
            if line.rstrip().endswith(';'):
                return src[start:e].rstrip()
    raise KeyError(f'{name} em {path}')

def rng(path, start_marker, end_marker):
    src = read(path)
    a = src.index(start_marker)
    a = src.rfind('\n', 0, a) + 1
    b = src.index(end_marker, a)
    if end_marker.strip() in ('});', '}, 1000);', '})();', '};'):
        b = src.find('\n', b + len(end_marker))
    else:
        b = src.rfind('\n', 0, b)
    return src[a:b].rstrip()

def mk(path, name=None, start=None, end=None, block=None):
    if block:
        src = read(path)
        s = src.index(block)
        s = src.rfind('\n', 0, s) + 1
        code = block_from(src, s)
    elif name:
        code = fn(path, name)
    else:
        code = rng(path, start, end)
    import textwrap
    code = textwrap.dedent(code)
    label = path.replace('assets/js/', '') + (f' · {name}()' if name else '')
    return {'f': label, 'c': code}

# Regras de negócio, lidas do Mapa (mesma fonte, mesma numeração)
mapa = open(MAPA, encoding='utf-8').read()
RN = {}
for rid, txt in re.findall(r'<li><span class="id">(RN-[A-Z]+-\d+)</span><span>(.*?)</span></li>', mapa, re.S):
    RN[rid] = re.sub(r'<[^>]+>', '', html.unescape(txt)).strip()

F = 'assets/js/'
S = 'server/server.js'

COLS = [
    ('Fontes e gatilhos', 'De onde os dados e as ações nascem'),
    ('Servidor · entrada', 'Segurança, descoberta e comandos'),
    ('Servidor · acompanhamento', 'Um laço por build em andamento'),
    ('Servidor · leitura do build', 'Log, estágios e resultado'),
    ('Servidor · saída', 'Eventos em tempo real e Jira'),
    ('Portal · entrada', 'Como os dados entram na tela'),
    ('Dados em memória', 'O que o portal guarda'),
    ('Funções de cálculo', 'Onde as métricas são calculadas'),
    ('Métricas', 'Cada número e sua fórmula'),
    ('Telas', 'Onde cada métrica aparece'),
]

N = []
def node(id, col, cat, title, where, body, formula=None, steps=None, rules=None, code=None, note=None):
    N.append(dict(id=id, col=col, cat=cat, title=title, where=where, body=body, formula=formula,
                  steps=steps or [], rules=[{'id': r, 't': RN.get(r, '')} for r in (rules or [])],
                  code=code or [], note=note))

# ---------- 0 · Fontes
node('src_jenkins', 0, 'fonte', 'Jenkins', 'API REST · Basic Auth (usuário + API token)',
     'Builds, log do console, estágios e relatório de testes de cada job configurado.',
     steps=['Lido pelo servidor, nunca pelo navegador.',
            'Endpoints: /job/…/api/json (builds), /…/logText/progressiveText (log), /…/wfapi/describe (estágios), /…/testReport/api/json (totais), /…/build e /…/stop (comandos).',
            'Jobs em pastas viram /job/Pasta/job/Job.'],
     rules=['RN-JEN-07'])
node('src_jira', 0, 'fonte', 'Jira', 'API REST v3 (Cloud) ou v2 (Server/DC)',
     'Cenários de teste por consulta (JQL) e bugs abertos para falhas.',
     steps=['Busca: /rest/api/3/search/jql (Cloud) ou /rest/api/2/search (Server).',
            'Criação: POST /issue · comentário: POST /issue/{chave}/comment.',
            'Autenticação: e-mail + API token (Cloud) ou token pessoal (Server).'],
     rules=['RN-JIR-04', 'RN-JIR-05'])
node('f_actions', 0, 'fonte', 'Ações da pessoa no portal', '81-acoes.js · 20-pipelines.js · 70-configuracoes.js',
     'Executar, parar, criar/renomear/excluir pasta e componente, ativar/desativar, editar configurações e filtros.',
     steps=['Sem servidor: Executar inicia a simulação (startLive).',
            'Conectado (?api=): Executar e Parar chamam POST /api/build e /api/stop.',
            'Excluir pasta: confirmação com o nome digitado, interrompe execuções, desfazer por 8 s.',
            'Configurações gravam em CFG (meta, IA, consulta do Jira).'],
     rules=['RN-PIP-02', 'RN-PIP-03', 'RN-PIP-05', 'RN-PIP-06', 'RN-PIP-07', 'RN-PIP-08', 'RN-PIP-09', 'RN-EXE-01'],
     code=[mk(F + '90-tempo-real.js', 'startRun'), mk(F + '90-tempo-real.js', 'triggerJenkins'),
           mk(F + '81-acoes.js', 'deleteFolder'), mk(F + '81-acoes.js', 'renameFolder')])
node('src_json', 0, 'fonte', 'Arquivo JSON importado', 'Execuções › Importar JSON',
     'Lista de execuções vinda de outra ferramenta.',
     formula='{ pipeline, total, passed, duration, inicio, grupo, tecnologia }',
     steps=['Aceita uma lista ou { "executions": [...] }.',
            'Campos alternativos: p, t/cenarios, ok/sucessos, duracao, start, group, tech.'],
     rules=['RN-EXE-09'])
node('src_sample', 0, 'fonte', 'Dados de exemplo', '01-dados.js · gen()',
     '13 componentes em 4 pastas e cerca de 7.600 execuções espalhadas em 6 meses, para testar sem servidor.',
     steps=['Gera execuções a cada 6–36 min, das 7h às 21h.',
            'Falha quando um sorteio passa da taxa de referência do componente menos um viés.',
            'Viés maior no Checkout, em execuções antigas e no horário de pico (10h–12h em dias úteis).'],
     formula='falha ⇔ sorteio × 100 > taxa − viés',
     code=[mk(F + '01-dados.js', start='(function gen()', end='})();')])
node('src_clock', 0, 'fonte', 'Relógio do portal', '91-conexao-servidor.js · setInterval 1 s',
     'Bate a cada segundo: avança a simulação, atualiza o tempo decorrido das esteiras reais e redesenha as telas abertas.',
     steps=['Simulação: avança 10 s de cenário por segundo real (SPEED = 10).',
            'A cada 6 batidas, inicia uma esteira nova se houver menos de 3 rodando (simulação automática).',
            'Esteiras do Jenkins: tempo decorrido = agora − início.'],
     rules=['RN-EXE-08'],
     code=[mk(F + '91-conexao-servidor.js', start='setInterval(() => {', end='}, 1000);')])

# ---------- 1 · Servidor entrada
node('s_auth', 1, 'servidor', 'Chave da API e CORS', 'server.js · authorized()',
     'Protege as rotas: /events, /api/state e as que alteram algo exigem a chave quando API_KEY está definida.',
     formula='x-api-key = API_KEY  ou  ?key = API_KEY',
     steps=['/api/health é livre.', 'CORS_ORIGIN define qual site pode chamar o servidor.'],
     rules=['RN-CFG-05'], code=[mk(S, 'authorized')])
node('s_discover', 1, 'servidor', 'Descoberta de builds', 'server.js · discover()',
     'A cada 30 s consulta os jobs configurados e começa a acompanhar cada build em andamento ainda não acompanhado.',
     formula='GET /job/{job}/api/json?tree=builds[number,building,timestamp,estimatedDuration]{0,5}',
     rules=['RN-JEN-01'], code=[mk(S, 'discover')])
node('s_cmd', 1, 'servidor', 'Executar e parar build', 'server.js · triggerBuild() · stopBuild()',
     'Recebe os comandos do portal e repassa ao Jenkins.',
     formula='POST /api/build {job, params?} → /job/{job}/build(WithParameters)\nPOST /api/stop {job, build} → /job/{job}/{build}/stop',
     steps=['Depois de disparar, procura builds de novo em 4 s (o build entra na fila antes de começar).'],
     code=[mk(S, 'triggerBuild'), mk(S, 'stopBuild')])
node('s_jirasc', 1, 'servidor', 'Cenários do Jira', 'server.js · jiraScenarios() · GET /api/jira/scenarios',
     'Busca as issues de teste pela consulta e devolve chave, nome, status, componente e link.',
     formula='componente = campo JIRA_PIPELINE_FIELD (components · labels · customfield)',
     steps=['Páginas de 100 issues, até 1.000.', 'Cloud pagina por nextPageToken; Server por startAt.',
            'Sem Jira configurado e em modo demonstração, devolve 6 cenários de exemplo.'],
     rules=['RN-CEN-02', 'RN-CEN-05'], code=[mk(S, 'jiraScenarios')])

# ---------- 2 · Acompanhamento
node('s_track', 2, 'servidor', 'Acompanhamento do build', 'server.js · track()',
     'Para cada build em andamento: emite o início e lê o log em laço até o Jenkins dizer que acabou.',
     formula='repetir a cada 3 s enquanto X-More-Data = true',
     steps=['Emite build_start com número, início, duração estimada e pasta.',
            'Lê só o trecho novo do log a partir do deslocamento (X-Text-Size).',
            'Lê os estágios a cada volta.', 'No fim, chama finish().'],
     rules=['RN-JEN-01'], code=[mk(S, 'track')])

# ---------- 3 · Leitura do build
node('s_parse', 3, 'servidor', 'Leitura do log', 'server.js · parseLines()',
     'Transforma cada linha de resultado do log num evento de cenário, com status, duração e tempo de resposta.',
     formula='linha ✓/✘ nome (1.2s) → {name, status, duration}\n[resp] CT-001 412ms → resp = 412',
     steps=['Junta a linha que veio cortada entre duas leituras.', 'Remove cores ANSI.',
            'Formatos: Playwright, Cypress/Mocha, Jest; outros por LOG_REGEX.',
            'Duração convertida para segundos (ms ÷ 1000, m × 60).',
            'Liga o tempo de resposta ao cenário pelo nome ou pelo ID CT-xxx.'],
     rules=['RN-JEN-02', 'RN-CEN-03'],
     code=[mk(S, 'parseLines'), mk(S, 'toSeconds'), mk(S, 'cleanName'), mk(S, 'respFor')])
node('s_stages', 3, 'servidor', 'Estágios da pipeline', 'server.js · pollStages()',
     'Emite um evento sempre que um estágio do Jenkins muda de status.',
     formula='GET /job/{job}/{n}/wfapi/describe',
     rules=['RN-JEN-05'], code=[mk(S, 'pollStages')])
node('s_finish', 3, 'servidor', 'Resultado final', 'server.js · finish()',
     'Fecha o build: status, duração e totais. Dispara os bugs no Jira se estiver ligado.',
     formula='ABORTED → Cancelada\nSUCCESS e falhas = 0 → Sucesso\nsenão → Falha\ntotal = aprovados + falhas + ignorados',
     steps=['Totais vêm do relatório JUnit; sem relatório, das linhas do log.'],
     rules=['RN-JEN-03', 'RN-JEN-04'], code=[mk(S, 'finish')])

# ---------- 4 · Saída
node('s_bug', 4, 'servidor', 'Bugs no Jira', 'server.js · reportBug() · findOpenBug()',
     'Para cada cenário que falhou: comenta no bug aberto do mesmo cenário ou cria um novo.',
     formula='JQL: project = X AND summary ~ "CT-xxx" AND statusCategory != Done',
     steps=['Só roda com JIRA_AUTO_BUG=true.', 'Título: [QA] componente – cenário; descrição com o link do build.',
            'Cloud recebe a descrição em formato ADF; Server em texto.'],
     rules=['RN-JIR-01', 'RN-JIR-02', 'RN-JIR-03'], code=[mk(S, 'findOpenBug'), mk(S, 'reportBug')])
node('s_emit', 4, 'servidor', 'Eventos em tempo real (SSE)', 'server.js · emit() · GET /events',
     'Envia cada evento a todos os portais conectados e guarda os últimos 300 para quem chega depois.',
     formula='eventos: build_start · scenario · stage · build_end · jira',
     steps=['Reconexão automática do navegador em 3 s (retry: 3000).', 'Ping a cada 25 s para manter a conexão aberta.'],
     rules=['RN-JEN-06'], code=[mk(S, 'emit')])

# ---------- 5 · Portal entrada
node('f_sse', 5, 'portal', 'Conexão com o servidor', '91-conexao-servidor.js · extStart() · extScenario() · extEnd()',
     'Ativa com ?api=. Converte os eventos do servidor em execuções e cenários na tela.',
     steps=['build_start: cria a execução (e o componente, se não existir).',
            'scenario: marca o cenário como rodando, aprovado ou falho e soma os aprovados.',
            'build_end: fecha a execução; cenários que não rodaram ficam “não executados”.',
            'Desliga a simulação e muda a aba para “Ao vivo · Jenkins”.'],
     rules=['RN-EXE-02', 'RN-EXE-03', 'RN-EXE-10'],
     code=[mk(F + '91-conexao-servidor.js', 'extStart'), mk(F + '91-conexao-servidor.js', 'extScenario'), mk(F + '91-conexao-servidor.js', 'extEnd')])
node('f_sim', 5, 'portal', 'Simulação ao vivo', '90-tempo-real.js · startLive() · advance()',
     'Sem servidor, executa a suíte de um componente cenário a cenário.',
     formula='duração planejada do cenário ∝ duração média do componente (± 20%)\nfalha ⇔ sorteio < (100 − taxa)/100 × 0,6\ncenários “propensos” (Timeout, Confirmar…): 55%',
     steps=['Bloqueia uma segunda execução do mesmo componente.', 'Timeout de API registra 30.000 ms.',
            'Tempo de resposta: API ≈ 180 ms, Web ≈ 410 ms, Mobile ≈ 620 ms (× 0,6–1,5; × 2,5 se falhou).'],
     rules=['RN-EXE-01', 'RN-EXE-05', 'RN-EXE-08'],
     code=[mk(F + '90-tempo-real.js', 'startLive'), mk(F + '90-tempo-real.js', 'advance'), mk(F + '90-tempo-real.js', 'respFor')])
node('f_import', 5, 'portal', 'Importação de JSON', '30-execucoes.js',
     'Lê o arquivo, cria componentes que faltam e adiciona as execuções no topo do histórico.',
     formula='status = passed = total ? Sucesso : Falha',
     rules=['RN-EXE-09'], code=[mk(F + '30-execucoes.js', start="$('#importJson').addEventListener", end='});')])
node('f_sync', 5, 'portal', 'Atualizar do Jira', '40-cenarios.js · syncJira()',
     'Chama /api/jira/scenarios com a consulta e o campo das Configurações e substitui a lista de cenários.',
     formula='CT-xxx no título → ID do cenário\nresto do título → nome',
     rules=['RN-CEN-01'], code=[mk(F + '40-cenarios.js', 'syncJira')])
node('f_store', 5, 'portal', 'Armazenamento do navegador', '00-base.js · store',
     'Guarda o que a pessoa cria ou muda, só naquele navegador.',
     formula='qa:pipes2 · qa:scens · qa:ints · qa:cfg · qa:jiraSync',
     rules=['RN-CFG-03'], code=[mk(F + '00-base.js', start='const store', end='};')])

# ---------- 6 · Dados
node('d_runs', 6, 'dados', 'RUNS · execuções', '01-dados.js',
     'Todas as execuções, da mais recente para a mais antiga.',
     formula='{ id, p, s, ok, t, d, at, live? }',
     steps=['p = componente · s = Sucesso | Falha | Executando | Cancelada', 'ok / t = cenários aprovados / total · d = duração (s) · at = início'])
node('d_live', 6, 'dados', 'LIVE · esteiras acompanhadas', '90-tempo-real.js',
     'Execuções rodando agora e as concluídas nesta sessão, com cada cenário.',
     formula='live.sc[] = { n, st, dur, resp }\nst = pend | run | pass | fail | skip')
node('d_pipes', 6, 'dados', 'PIPES · componentes', '01-dados.js',
     'Componentes com pasta, plataforma e valores de referência.',
     formula='{ name, group, tech, rate, dur, scen, active? }',
     steps=['rate e dur são referências usadas só quando não há histórico.'], rules=['RN-PIP-01'])
node('d_scens', 6, 'dados', 'SCENS · cenários', '40-cenarios.js',
     'Cenários vindos do Jira (ou de exemplo).',
     formula='{ key, id, name, p, js, url }')
node('d_cfg', 6, 'dados', 'CFG · configurações', '70-configuracoes.js',
     'Preferências que mudam cálculos e telas.',
     formula='goal = 95 · ai = false · jql · jiraField = components',
     rules=['RN-CFG-01', 'RN-CFG-02'])
node('d_events', 6, 'dados', 'EVENTS · feed', '90-tempo-real.js · logEvent()',
     'Linha do tempo do que aconteceu ao vivo.', formula='até 60 eventos, mais recente primeiro', rules=['RN-EXE-07'])

# ---------- 7 · Cálculo
node('c_period', 7, 'calculo', 'Recorte do período', '50-analises.js · periodRange() · runsIn()',
     'Separa as execuções concluídas da janela escolhida e da janela anterior de mesmo tamanho.',
     formula='fim = meia-noite do dia seguinte\ninício = fim − dias\nanterior = [início − dias, início)\nentram só Sucesso e Falha',
     rules=['RN-ANA-01', 'RN-ANA-02', 'RN-DASH-02'],
     code=[mk(F + '50-analises.js', 'periodRange'), mk(F + '50-analises.js', 'runsIn')])
node('c_metrics', 7, 'calculo', 'Indicadores do período', '50-analises.js · metrics()',
     'Calcula de uma vez execuções, aprovadas, falhas, taxa, cenários, flaky e MTTR.',
     formula='n = execuções · ok = Sucesso · falhas = n − ok\ntaxa = ok ÷ n × 100',
     code=[mk(F + '50-analises.js', 'metrics')])
node('c_scen', 7, 'calculo', 'Resultado por cenário', '50-analises.js · scenarioStats() · 01-dados.js · suiteFor()',
     'Abre cada execução em cenários e conta, por cenário, quantas vezes rodou e falhou.',
     formula='chave = componente | cenário\nruns += 1 · fails += 1 se falhou',
     steps=['suiteFor distribui as falhas da execução: primeiro nos cenários marcados como propensos, depois do fim para o início.'],
     code=[mk(F + '50-analises.js', 'scenarioStats'), mk(F + '01-dados.js', 'suiteFor')])
node('c_mttr', 7, 'calculo', 'Tempo até corrigir', '50-analises.js · mttr()',
     'Percorre as execuções em ordem de data, componente a componente.',
     formula='para cada componente:\n  1ª Falha abre o relógio\n  próximo Sucesso fecha → intervalo\nMTTR = média dos intervalos',
     rules=['RN-ANA-04'], code=[mk(F + '50-analises.js', 'mttr')])
node('c_cause', 7, 'calculo', 'Classificação da causa', '50-analises.js · failCause()',
     'Agrupa as falhas pela mensagem de erro.',
     formula='“Timeout” → Timeout de API\n“500” / Confirmar → HTTP 500\nresto → Validação / dados',
     note='Com dados de exemplo, parte dos cenários recebe a causa de forma simulada.',
     rules=['RN-ANA-05'], code=[mk(F + '50-analises.js', 'failCause')])
node('c_buckets', 7, 'calculo', 'Série no tempo', '50-analises.js · buckets()',
     'Divide o período em fatias e conta aprovadas e falhas em cada uma.',
     formula='fatia = 1 dia (até 30 dias) · 7 dias (90 dias)\nalinhada pelo fim do período\ntaxa da fatia = ok ÷ (ok + falhas)',
     rules=['RN-ANA-03'], code=[mk(F + '50-analises.js', 'buckets')])
node('c_dash', 7, 'calculo', 'Números do Dashboard', '10-dashboard.js · dashData()',
     'Mesmo recorte de 7 dias para todos os cards do Dashboard.',
     formula='Δ execuções = (n − n_anterior) ÷ n_anterior\nmédia geral = Σd ÷ n\nfalhas por pipeline = top 3 + Outros',
     rules=['RN-DASH-01', 'RN-DASH-04', 'RN-DASH-06', 'RN-DASH-07'], code=[mk(F + '10-dashboard.js', 'dashData')])
node('c_bytech', 7, 'calculo', 'Média por plataforma (Dashboard)', '10-dashboard.js · durByTech()',
     'Uma média independente para API, Mobile e Web.',
     formula='média(API) = Σ d das execuções de API ÷ nº de execuções de API',
     rules=['RN-DASH-05'], code=[mk(F + '10-dashboard.js', 'durByTech')])
node('c_audit', 7, 'calculo', 'Base do tempo de execução', '51-analises-tempo.js · auditData()',
     'Uma linha por componente filtrado: execuções do período, soma, média, execução mais recente e se está rodando.',
     formula='média = Σ d ÷ n  (sem execuções: referência do componente)\nΔ = mais recente ÷ média − 1',
     steps=['Filtros: projeto, plataforma, componentes escolhidos e somente ativos.'],
     rules=['RN-PIP-10', 'RN-ANA-06'], code=[mk(F + '51-analises-tempo.js', 'auditData')])
node('c_tcard', 7, 'calculo', 'Cards por plataforma (Tempo)', '51-analises-tempo.js · tempoCard()',
     'Soma as linhas de uma plataforma.',
     formula='média = Σ somas ÷ Σ execuções\ntotal atual = Σ mais recentes\nΔ = total atual ÷ Σ médias − 1',
     rules=['RN-ANA-06', 'RN-ANA-07', 'RN-ANA-08'], code=[mk(F + '51-analises-tempo.js', 'tempoCard')])
node('c_card', 7, 'calculo', 'Card da esteira ao vivo', '90-tempo-real.js · updateCard()',
     'Calcula tempo, projeção e resposta média de uma esteira rodando.',
     formula='projeção = decorrido ÷ concluídos × total\nΔ = projeção ÷ média − 1\nrestante ≈ média − decorrido',
     rules=['RN-EXE-04', 'RN-EXE-05'], code=[mk(F + '90-tempo-real.js', 'updateCard')])
node('c_livekpi', 7, 'calculo', 'Indicadores ao vivo', '90-tempo-real.js · renderLive()',
     'Junta todos os cenários das esteiras acompanhadas.',
     formula='resposta média = Σ resp ÷ nº (sem timeouts de 30.000 ms)\ntimeouts = cenários com resp ≥ 30.000',
     code=[mk(F + '90-tempo-real.js', 'renderLive')])
node('c_last', 7, 'calculo', 'Último resultado do cenário', '40-cenarios.js · lastResult()',
     'Procura o cenário na execução mais recente (não cancelada) do componente.',
     formula='encontra por ID CT-xxx ou pelo nome\nsenão → Sem execução',
     rules=['RN-CEN-03', 'RN-CEN-04'], code=[mk(F + '40-cenarios.js', 'lastResult')])
node('c_folder', 7, 'calculo', 'Resumo da pasta', '20-pipelines.js · renderPipes()',
     'Agrupa os componentes por pasta e resume cada uma.',
     formula='composição = contagem por plataforma\ncom falha = componentes cuja última execução falhou\nmédia da pasta = Σ d ÷ n das execuções dos componentes\n(todas, menos as em andamento)',
     rules=['RN-PIP-04'], code=[mk(F + '20-pipelines.js', start='const items = rows.filter(x => x.p.group === gn)', end="const phrase")])

# ---------- 8 · Métricas
def metric(id, title, formula, body, rules=None, code=None, note=None):
    node(id, 8, 'metrica', title, '', body, formula=formula, rules=rules, code=code, note=note)
metric('m_exec', 'Execuções', 'n = nº de execuções Sucesso + Falha no período\nΔ% = (n − n_ant) ÷ n_ant × 100',
       'Volume de execuções concluídas.', ['RN-DASH-02', 'RN-DASH-04', 'RN-ANA-02'])
metric('m_rate', 'Taxa de sucesso', 'taxa = ok ÷ n × 100\nΔ = taxa − taxa_ant (em pontos percentuais)\nsérie: uma taxa por dia ou semana',
       'Percentual de execuções sem nenhum cenário falho.', ['RN-DASH-03', 'RN-ANA-02', 'RN-ANA-03'])
metric('m_fail', 'Execuções com falha', 'falhas = n − ok\n% de falhas = falhas ÷ n × 100\nΔ% em relação ao período anterior',
       'Execuções com pelo menos um cenário falho.')
metric('m_mttr', 'MTTR', 'média de (próximo Sucesso − 1ª Falha)\npor componente, no período',
       'Tempo médio para um componente voltar a passar.', ['RN-ANA-04'])
metric('m_avgtech', 'Duração média por plataforma', 'média(P) = Σ d(P) ÷ n(P)\nP = API · Mobile · Web',
       'Média própria de cada plataforma; não é derivada do total.', ['RN-DASH-05', 'RN-ANA-06'])
metric('m_avggeral', 'Duração média geral', 'Σ d ÷ n de todas as execuções\nΔ% vs 7 dias anteriores',
       'Referência pequena no rodapé do card do Dashboard.')
metric('m_fpp', 'Falhas por pipeline', '% = falhas do componente ÷ total de falhas\ntop 3 + “Outros”',
       'Onde as falhas se concentram nos últimos 7 dias.', ['RN-DASH-06'])
metric('m_cause', 'Falhas por causa raiz', '% = cenários com falha da causa ÷ cenários com falha',
       'Timeout de API, HTTP 500 e Validação / dados.', ['RN-ANA-05'])
metric('m_heat', 'Mapa de calor de falhas', 'célula = nº de execuções com falha\nno dia da semana × hora (7h–21h)\ncor ∝ célula ÷ maior célula',
       'Dia e horário com mais falhas; o pico é destacado.',
       code=[mk(F + '50-analises.js', start='const dnames', end='let peak')])
metric('m_failcomp', 'Falhas por componente', 'falhas(C) = execuções Falha de C no período\nmostra só C com falhas > 0',
       'Ranking de componentes que mais falharam.')
metric('m_goal', 'Abaixo da meta', 'taxa(C) = ok(C) ÷ n(C) × 100\nlista C com taxa(C) < meta (CFG.goal, padrão 95%)\nsó componentes que rodaram no período',
       'Componentes que não atingiram a meta de sucesso.', ['RN-ANA-10', 'RN-CFG-01'])
metric('m_flaky', 'Testes instáveis (flaky)', 'flaky ⇔ 0 < falhas(cenário) < execuções(cenário)\ntaxa = falhas ÷ execuções × 100\nmostra os 8 maiores',
       'Cenários que falharam e também passaram no período.', ['RN-ANA-09'])
metric('m_tot', 'Tempo total atual e Δ', 'total = Σ execução mais recente de cada componente\nΔ = total ÷ Σ médias − 1\nsubtotal por projeto e total geral',
       'Quanto leva um ciclo completo hoje, comparado ao normal.', ['RN-ANA-07', 'RN-ANA-08', 'RN-ANA-11'],
       code=[mk(F + '51-analises-tempo.js', 'auditCsv')])
metric('m_proj', 'Projeção da esteira', 'projeção = decorrido ÷ concluídos × total\nΔ = projeção ÷ média − 1',
       'Estimativa, durante a execução, de quanto ela vai levar.', ['RN-EXE-04'])
metric('m_resp', 'Tempo de resposta', 'por cenário: ms medido (linha [resp] ou simulação)\nvermelho ≥ 1.000 ms · timeout = 30.000 ms\nmédia ignora timeouts',
       'Quanto o sistema testado demorou para responder.', ['RN-EXE-05'])
metric('m_last', 'Último resultado do cenário', 'situação do cenário na execução mais recente\nnão cancelada do componente',
       'Se o cenário do Jira passou, falhou ou ainda não rodou.', ['RN-CEN-04'])
metric('m_folder', 'Composição e estado da pasta', '“3 de API, 1 de Mobile e 1 de Web”\ncom falha = última execução Falha',
       'Resumo de cada projeto em Pipelines.', ['RN-PIP-04'])

# ---------- 9 · Telas
def tela(id, title, where, body, rules=None):
    node(id, 9, 'tela', title, where, body, rules=rules)
tela('t_dash', 'Dashboard', '#dashboard · 10-dashboard.js', 'Últimos 7 dias: execuções, sucessos, falhas, duração por plataforma, evolução, falhas por pipeline e últimas execuções.', ['RN-DASH-01'])
tela('t_pip', 'Pipelines', '#pipelines · 20-pipelines.js', 'Pastas e componentes, filtros, criar, renomear, excluir e executar.')
tela('t_hist', 'Execuções › Histórico', '#execucoes · 30-execucoes.js', 'Lista paginada (10 por página) com filtros e Importar JSON.', ['RN-EXE-06'])
tela('t_live', 'Execuções › Ao vivo', '#aovivo · 90-tempo-real.js', 'Cards por esteira, concluídas recentemente e feed de eventos.', ['RN-EXE-07'])
tela('t_det', 'Detalhe da execução', '#exec-N · 31-detalhe.js', 'Cenários, logs e evidências de uma execução; reexecutar.')
tela('t_cen', 'Cenários', '#cenarios · 40-cenarios.js', 'Cenários do Jira com chave, status e último resultado.')
tela('t_q', 'Análises › Qualidade', '#analises · 50-analises.js', 'Indicadores com comparação, série, causa raiz e mapa de calor.')
tela('t_tempo', 'Análises › Tempo de execução', '#analises · 51-analises-tempo.js', 'Cards por plataforma, tabela por componente, subtotais e CSV para auditoria.')
tela('t_est', 'Análises › Estabilidade', '#analises · 50-analises.js', 'Falhas por componente, abaixo da meta e testes instáveis.')
tela('t_ag', 'Agente de QA (opcional)', '#agente · 95-agente-ia.js', 'Responde por regras sobre os mesmos dados. Escondido por padrão.', ['RN-NAV-03', 'RN-IA-01', 'RN-IA-02'])

E = []
def e(a, b, label=''):
    E.append({'a': a, 'b': b, 'l': label})

e('src_jenkins', 's_discover', 'builds em andamento'); e('src_jenkins', 's_track', 'log · estágios · resultado')
e('f_actions', 's_cmd', 'Executar / Parar (conectado)'); e('src_jira', 's_jirasc', 'busca por JQL'); e('src_jira', 's_bug', 'busca bug aberto')
e('s_discover', 's_track', 'build novo'); e('s_auth', 's_emit', 'protege /events'); e('s_auth', 'f_sync', 'protege /api')
e('s_track', 's_parse', 'trecho do log'); e('s_track', 's_stages'); e('s_track', 's_finish', 'log acabou')
e('s_track', 's_emit', 'build_start'); e('s_parse', 's_emit', 'scenario'); e('s_stages', 's_emit', 'stage')
e('s_finish', 's_emit', 'build_end'); e('s_finish', 's_bug', 'cenários que falharam'); e('s_bug', 's_emit', 'jira')
e('s_emit', 'f_sse', 'SSE'); e('s_jirasc', 'f_sync', 'cenários')
e('f_actions', 'f_sim', 'Executar (sem servidor)'); e('src_clock', 'f_sim', 'a cada 1 s'); e('src_clock', 'f_sse', 'tempo decorrido')
e('src_json', 'f_import')
e('f_sse', 'd_runs'); e('f_sse', 'd_live'); e('f_sse', 'd_events'); e('f_sse', 'd_pipes', 'componente novo')
e('f_sim', 'd_runs'); e('f_sim', 'd_live'); e('f_sim', 'd_events')
e('f_import', 'd_runs'); e('f_import', 'd_pipes'); e('f_sync', 'd_scens')
e('f_store', 'd_pipes'); e('f_store', 'd_scens'); e('f_store', 'd_cfg')
e('src_sample', 'd_runs'); e('src_sample', 'd_pipes'); e('src_sample', 'd_scens')
e('f_actions', 'd_pipes', 'criar · renomear · excluir'); e('f_actions', 'd_live', 'Parar'); e('f_actions', 'd_cfg', 'meta · IA · consulta')
e('d_runs', 'c_period'); e('d_runs', 'c_dash'); e('d_runs', 'c_last'); e('d_runs', 'c_folder', 'última execução')
e('d_live', 'c_card'); e('d_live', 'c_livekpi'); e('d_live', 'c_audit', 'rodando agora'); e('d_live', 'c_last')
e('d_pipes', 'c_bytech', 'plataforma'); e('d_pipes', 'c_audit', 'filtros · ativos'); e('d_pipes', 'c_folder')
e('d_pipes', 'c_card', 'média de referência'); e('d_scens', 'c_last'); e('d_cfg', 'm_goal', 'meta')
e('c_period', 'c_metrics'); e('c_period', 'c_scen'); e('c_period', 'c_mttr'); e('c_period', 'c_buckets')
e('c_period', 'c_audit'); e('c_period', 'c_bytech', '7 dias'); e('c_period', 'm_heat'); e('c_period', 'm_failcomp'); e('c_period', 'm_goal')
e('c_scen', 'c_cause'); e('c_scen', 'm_flaky'); e('c_mttr', 'c_metrics')
e('c_metrics', 'm_exec'); e('c_metrics', 'm_rate'); e('c_metrics', 'm_fail'); e('c_metrics', 'm_mttr')
e('c_buckets', 'm_rate', 'série'); e('c_cause', 'm_cause')
e('c_dash', 'm_exec', '7 dias'); e('c_dash', 'm_rate', '7 dias'); e('c_dash', 'm_fail', '7 dias'); e('c_dash', 'm_avggeral'); e('c_dash', 'm_fpp')
e('c_bytech', 'm_avgtech', 'Dashboard'); e('c_audit', 'c_tcard'); e('c_audit', 'm_tot'); e('c_tcard', 'm_avgtech', 'aba Tempo'); e('c_tcard', 'm_tot')
e('c_card', 'm_proj'); e('c_card', 'm_resp'); e('c_livekpi', 'm_resp'); e('c_last', 'm_last'); e('c_folder', 'm_folder')
e('m_exec', 't_dash'); e('m_exec', 't_q'); e('m_rate', 't_dash'); e('m_rate', 't_q'); e('m_fail', 't_dash'); e('m_fail', 't_q')
e('m_mttr', 't_q'); e('m_avgtech', 't_dash'); e('m_avgtech', 't_tempo'); e('m_avggeral', 't_dash'); e('m_fpp', 't_dash')
e('m_cause', 't_q'); e('m_heat', 't_q'); e('m_failcomp', 't_est'); e('m_goal', 't_est'); e('m_flaky', 't_est'); e('m_flaky', 't_ag')
e('m_tot', 't_tempo'); e('m_proj', 't_live'); e('m_resp', 't_live'); e('m_last', 't_cen'); e('m_folder', 't_pip')
e('d_runs', 't_hist'); e('d_runs', 't_det'); e('d_events', 't_live'); e('d_live', 't_det', 'cenários ao vivo')
e('m_fail', 't_ag'); e('m_proj', 't_ag')

ids = {n['id'] for n in N}
for x in E:
    assert x['a'] in ids and x['b'] in ids, x
    ca = next(n['col'] for n in N if n['id'] == x['a']); cb = next(n['col'] for n in N if n['id'] == x['b'])
    assert cb >= ca, ('volta', x)
missing = [r['id'] for n in N for r in n['rules'] if not r['t']]
assert not missing, missing

NOTES = [
    {'col': 0, 'text': 'COMO LER\n1) Os dados correm da esquerda para a direita: fontes → servidor → portal → cálculo → métrica → tela.\n2) Clique num nó para ver fórmula, passo a passo, regras e o código real.\n3) “Caminho” acende tudo de onde o número vem e para onde vai.'},
    {'col': 0, 'text': 'DOIS MODOS\nSem servidor: dados de exemplo + simulação 10× acelerada.\nConectado (?api=): Jenkins e Jira reais pelo servidor; a simulação desliga.'},
    {'col': 6, 'text': 'REGRA DE OURO\nO navegador nunca chama Jenkins ou Jira. Tokens só no servidor (.env).'},
    {'col': 8, 'text': 'TODA MÉTRICA DE PERÍODO\nusa só execuções Sucesso e Falha. Executando e Cancelada ficam de fora.'},
]

data = {'cols': COLS, 'nodes': N, 'edges': E, 'notes': NOTES}
tpl = open(sys.argv[4], encoding='utf-8').read()
out = tpl.replace('/*__DATA__*/null', json.dumps(data, ensure_ascii=False).replace('</', '<\\/'))
if '--completo' in sys.argv:
    sys.path.insert(0, __import__('os').path.dirname(__file__))
    from completo import completo
    out = completo(out, {'https://claude.ai/artifact/5MmN5uxPaJfc6c4UNoGBF5': 'mapa-funcionalidades.html'})
open(OUT, 'w', encoding='utf-8').write(out)
print(len(N), 'nós ·', len(E), 'ligações ·', sum(len(n['code']) for n in N), 'trechos de código ·', len(RN), 'regras disponíveis')
