# Mapa de funcionalidades e Canvas de ligações

Dois documentos explicam **como a plataforma funciona por dentro**. Ambos são HTML puro: abra direto no navegador ou pelo GitHub Pages.

| Documento | Para que serve | Arquivo |
|---|---|---|
| **Mapa de funcionalidades** | Visão por **categoria**: o que cada parte faz, o diagrama da lógica e as **regras de negócio numeradas** (RN-…). Tem um catálogo único com todas as regras e filtro. | [`docs/mapa/mapa-funcionalidades.html`](mapa/mapa-funcionalidades.html) |
| **Canvas de ligações** | Visão de **fluxo**: como os dados saem do Jenkins, do GitHub Actions e do Jira, passam pelo servidor, viram dados no portal, são calculados e chegam a cada métrica e tela. Cada nó mostra a **fórmula**, as **regras** e o **código real** da função. | [`docs/mapa/canvas-ligacoes.html`](mapa/canvas-ligacoes.html) |

Os dois se completam: o Mapa responde **"qual é a regra?"** e o Canvas responde **"de onde vem esse número e qual função o calcula?"**. As regras usam a mesma numeração nos dois, e o Canvas tem um link para o Mapa.

## Mapa de funcionalidades

![Mapa de funcionalidades](img/mapa-categoria.png)

- **14 seções:** visão geral, navegação e acesso, Dashboard, Pipelines, Execuções e Ao vivo, Cenários (Jira), Análises, Servidor: Jenkins, Servidor: GitHub Actions, Servidor: Jira, Servidor: sincronização do Jira e ciclos de teste, Configurações e dados, Agente de QA e Login e permissões.
- Cada seção tem um **status** (Implementado, Opcional ou Proposta), os arquivos de código, um **diagrama Mermaid** da lógica, as funcionalidades e as **regras de negócio**.
- **Todas as regras:** tabela no fim com busca e filtro por categoria. Ela é montada a partir das regras escritas em cada seção, que são a única fonte.
- Os diagramas usam o Mermaid, carregado do CDN jsDelivr. Sem internet, a página abre normalmente, mas os diagramas aparecem como texto.

## Canvas de ligações

![Canvas de ligações](img/canvas.png)

Os dados correm **da esquerda para a direita**, em 10 colunas:

1. **Fontes e gatilhos:** Jenkins, GitHub Actions, Jira, Zephyr Scale, ações da pessoa, JSON importado, dados de exemplo e o relógio do portal.
2. **Servidor · entrada:** chave da API e CORS, descoberta de builds, executar e parar, cenários do Jira, espera e nova tentativa (429/503).
3. **Servidor · acompanhamento:** o laço `track()` de cada build.
4. **Servidor · leitura do build:** log (`parseLines`), estágios (`pollStages`) e resultado (`finish`).
5. **Servidor · saída:** eventos SSE (`emit`), bugs no Jira (`reportBug`) e sincronização do Jira e dos ciclos (`syncJira`).
6. **Portal · entrada:** conexão SSE, simulação, importação, atualizar do Jira e armazenamento do navegador.
7. **Dados em memória:** `RUNS`, `LIVE`, `PIPES`, `SCENS`, `CFG` e `EVENTS`.
8. **Funções de cálculo:** `periodRange`, `metrics`, `mttr`, `scenarioStats`, `failCause`, `buckets`, `dashData`, `durByTech`, `auditData`, `tempoCard`, `updateCard` e outras.
9. **Métricas:** cada número com a sua fórmula (taxa de sucesso, MTTR, média por plataforma, tempo total atual, projeção, flaky…).
10. **Telas:** onde cada métrica aparece.

São **76 nós, 132 ligações e 57 trechos de código**.

![Detalhe de um nó](img/canvas-detalhe.png)

### Como usar

- **Mover:** arraste o fundo. **Zoom:** roda do mouse, gesto de pinça ou os botões − / +. **Ajustar** mostra tudo de uma vez.
- **Clique num nó** para abrir o painel com: o que faz, fórmula, passo a passo, de onde recebe e para onde envia (clicáveis), regras de negócio e o código real.
- Ao selecionar um nó, **acende o caminho completo**: tudo o que leva até ele e tudo o que depende dele. As outras partes ficam apagadas.
- **Rótulos** mostra o nome de cada ligação (por exemplo `build_end`, `scenario`, `7 dias`).
- A **busca** encontra função, métrica, tela, arquivo ou código de regra. A **legenda** destaca um tipo de nó.
- O endereço guarda o nó aberto (`canvas-ligacoes.html#m-avgtech`), para mandar um link direto.
- **Esc** fecha o painel.

## Gerar os dois com um comando

```bash
python3 docs/mapa/gerar_docs.py
```

O script lê o projeto inteiro e grava `docs/mapa/mapa-funcionalidades.html` e `docs/mapa/canvas-ligacoes.html`. Roda em cerca de 0,1 s, usa só o Python 3.8+ (nada para instalar, sem rede) e gera sempre a mesma saída para o mesmo código.

### De onde vem cada coisa

| Conteúdo | Origem |
|---|---|
| Funções, código, comentários acima delas e **quem chama quem** | Automático (lido de `assets/js` e `server/`) |
| Rotas HTTP, eventos emitidos, variáveis de ambiente, chaves do `localStorage`, dados globais | Automático (seção "Descoberto no código" do Mapa) |
| Regras escritas em comentários (`// RN-ABC-01 texto`) | Automático |
| Categorias, regras de negócio, fórmulas das métricas, diagramas e a curadoria do Canvas | [`mapa.config.json`](../mapa.config.json), na raiz do projeto |

### Por que um script **e** um arquivo de configuração

Havia duas formas de reaproveitar a documentação em outro projeto. Só um prompt é frágil: depende de uma IA, cada execução sai diferente, nada valida o resultado e ele desatualiza sozinho. Só um script não basta, porque regra de negócio e fórmula **não estão escritas no código**: o script descobre a estrutura, mas não o que ela significa. A combinação resolve:

- o **script** faz o que é mecânico, valida e é repetível;
- o **`mapa.config.json`** guarda o que só uma pessoa (ou uma IA) sabe;
- o **prompt** ([`docs/mapa/PROMPT.md`](mapa/PROMPT.md)) ensina uma IA a preencher o config de um projeto novo.

### Comandos

| Comando | O que faz |
|---|---|
| `python3 docs/mapa/gerar_docs.py` | Gera o Mapa e o Canvas. |
| `… --so mapa` ou `--so canvas` | Gera só um dos dois. |
| `… --init` | Cria um `mapa.config.json` inicial a partir do código (não sobrescreve um existente). |
| `… --prompt` | Imprime o prompt para uma IA completar o config. |
| `… --estrito` | Transforma avisos em erro (bom para CI). |
| `… --config ARQ`, `--saida PASTA`, `--max-nos N`, `--ignorar PADRÃO` | Ajustes de caminho e de tamanho. |

### O que ele valida

O script **para com erro** e lista cada problema quando:

- o config cita uma função ou arquivo que não existe (por exemplo, depois de renomear uma função);
- um nó do Canvas cita uma regra que não existe;
- uma ligação aponta para um nó inexistente ou volta para uma coluna anterior;
- há regras repetidas ou JSON inválido.

E **avisa** (sem parar) quando um arquivo do código não está em nenhuma categoria do Mapa, ou quando há uma regra `RN-…` num comentário que não está no Mapa.

### Usar em outro projeto

1. Copie só o arquivo `docs/mapa/gerar_docs.py` para o outro projeto.
2. Rode `python3 gerar_docs.py . --init`. Ele cria o `mapa.config.json` com as categorias e funções que encontrou.
3. Cole o prompt de `python3 gerar_docs.py --prompt` no seu agente de código para completar o config (regras, fórmulas, diagramas, nós do Canvas).
4. Rode `python3 gerar_docs.py .`.

**Sem completar o config**, o comando já gera uma versão automática: o Mapa com uma categoria por pasta (funções, rotas, variáveis e regras dos comentários) e o Canvas organizado pelo grafo de chamadas (quem chama fica à esquerda). Ela é estrutural: mostra **como o código se liga**, não **o que significa**. Fórmulas e regras de negócio só aparecem depois que o config é preenchido.

### Mantendo em dia

Depois de mudar o código, rode o comando de novo. As funções, rotas, eventos e variáveis se atualizam sozinhos. Só o conteúdo escrito à mão exige edição:

- **nova regra de negócio:** adicione em `categorias[].regras` do config (ou num comentário `// RN-XXX-NN texto` ao lado do código);
- **nova métrica ou tela no Canvas:** adicione um nó em `canvas.nos` e as ligações em `canvas.ligacoes`;
- **função renomeada:** o script diz qual referência quebrou; corrija o nome no config.

Os diagramas do Mapa usam o Mermaid, carregado do CDN jsDelivr quando a página abre. Sem internet, eles aparecem como texto.
