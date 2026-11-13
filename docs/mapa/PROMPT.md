# Prompt: completar o mapa.config.json de um projeto

Cole o texto abaixo no seu agente de código (Claude Code, Antigravity, Copilot…) dentro da pasta do projeto.
O resultado é um arquivo `mapa.config.json`; depois, um único comando gera o **Mapa de funcionalidades** e o **Canvas de ligações**.

---

Você vai documentar este projeto. **Não altere nenhum arquivo de código.** Seu único produto é o arquivo `mapa.config.json` na raiz.

## Contexto

Existe um script, `gerar_docs.py`, que lê o código do projeto e gera dois documentos HTML em `docs/mapa/`:

1. **Mapa de funcionalidades** (`mapa-funcionalidades.html`): uma seção por categoria, com o diagrama da lógica, as funcionalidades e as **regras de negócio numeradas**, mais um catálogo de regras com busca.
2. **Canvas de ligações** (`canvas-ligacoes.html`): um quadro de nós ligados por fios, da esquerda para a direita: fontes → entrada → processamento → dados → funções de cálculo → métricas → telas. Cada nó mostra a **fórmula**, as **regras** e o **código real** da função.

O script descobre sozinho funções, chamadas entre elas, rotas, eventos, variáveis de ambiente e chaves de armazenamento. **Você escreve o que o código não diz sozinho**: nomes das categorias, regras de negócio, fórmulas e a curadoria do Canvas.

## Passo a passo

1. Rode `python3 gerar_docs.py . --init`. Ele cria o `mapa.config.json` com as categorias e funções que encontrou. Leia o arquivo.
2. Leia o código de cada categoria. Entenda o que o sistema faz de verdade antes de escrever.
3. Complete o config seguindo o formato abaixo.
4. Rode `python3 gerar_docs.py .`. Se houver erros, corrija o config e rode de novo, até não haver nenhum.
5. Abra os dois HTML e confira por amostragem: 5 regras e 5 fórmulas contra o código.

## Formato do `mapa.config.json`

Os textos aceitam `código` entre crases e **negrito**. Todo o resto é texto puro.

```json
{
  "nome": "Nome do Projeto",
  "subtitulo": "Mapa de funcionalidades e regras",
  "lead": "Uma ou duas frases sobre o que o documento mostra.",
  "legenda": [
    { "tipo": "real", "rotulo": "Implementado", "texto": "funciona de verdade" },
    { "tipo": "sim", "rotulo": "Simulado", "texto": "usa dados de exemplo" },
    { "tipo": "opt", "rotulo": "Opcional", "texto": "desligado por padrão" },
    { "tipo": "prop", "rotulo": "Proposta", "texto": "desenhado, ainda não implementado" }
  ],
  "visao_geral": {
    "titulo": "Visão geral da arquitetura",
    "descricao": "Como as partes se falam, em 2 a 4 frases.",
    "diagrama": "flowchart LR\n  A[\"Navegador\"] --> B[\"Servidor\"]",
    "nota": "Modos de uso ou limitações importantes (opcional)."
  },
  "categorias": [
    {
      "id": "dashboard",
      "titulo": "Dashboard",
      "status": "Implementado",
      "status_tipo": "real",
      "descricao": "Uma frase: o que esta parte faz.",
      "codigo": "`10-dashboard.js` (função `dashData`)",
      "diagrama": "flowchart LR\n  R[\"Execuções\"] --> W[\"Últimos 7 dias\"]",
      "nota": "Aviso curto, se houver (opcional).",
      "funcionalidades": [["Indicadores", "O que o usuário vê e o que cada item significa."]],
      "regras": [["RN-DASH-01", "O período é sempre os últimos 7 dias."]]
    }
  ],
  "canvas": {
    "titulo": "Ligações do Nome do Projeto",
    "categorias": {
      "fonte": { "nome": "Fonte", "cor": "#f2a93b", "detalhe": "Formato" },
      "calculo": { "nome": "Cálculo", "cor": "#4fd17a", "detalhe": "Fórmula" }
    },
    "colunas": [
      ["Fontes e gatilhos", "De onde os dados nascem"],
      ["Funções de cálculo", "Onde as métricas são calculadas"]
    ],
    "nos": [
      {
        "id": "c_metrics",
        "col": 1,
        "cat": "calculo",
        "titulo": "Indicadores do período",
        "onde": "50-analises.js · metrics()",
        "descricao": "O que o nó faz, em 1 ou 2 frases.",
        "formula": "taxa = ok ÷ n × 100",
        "passos": ["Passo 1", "Passo 2"],
        "regras": ["RN-ANA-02"],
        "nota": "Aviso (opcional).",
        "codigo": [{ "arquivo": "assets/js/50-analises.js", "funcao": "metrics" }]
      }
    ],
    "ligacoes": [
      ["src_jenkins", "c_metrics", "builds"],
      ["c_metrics", "m_rate"]
    ],
    "notas": [{ "col": 0, "texto": "COMO LER\nPrimeira linha em destaque; as demais explicam." }]
  }
}
```

Referências de código aceitas em `codigo`:

- `{"arquivo": "caminho/x.js", "funcao": "nome"}`: a função inteira (o caso normal).
- `{"arquivo": "...", "bloco": "texto onde o bloco começa"}`: o bloco `{…}` que começa naquela linha.
- `{"arquivo": "...", "inicio": "texto", "fim": "texto"}`: do marcador inicial até a linha do marcador final (inclusive). Troque `fim` por `antes_de` para parar na linha anterior.

## Regras para escrever

**Fidelidade (a mais importante)**

- Escreva só o que o código faz. Confira cada regra e cada fórmula lendo a função. Se um número aparece (7 dias, 95%, 300 eventos), ele vem de uma constante do código.
- Se algo está desenhado e não existe no código, marque a categoria como **Proposta** (`"status": "Proposta", "status_tipo": "prop"`).
- Se algo só funciona com dados de exemplo, **Simulado** (`"sim"`). Se vem desligado, **Opcional** (`"opt"`).
- Não invente nomes de função. Todo `codigo` é validado pelo script e o erro diz qual falhou.

**Regras de negócio**

- IDs no formato `RN-<SIGLA>-<NN>`: sigla de 3 a 5 letras por categoria (DASH, ANA, PIP…), números sequenciais, **nunca reutilizados**.
- Uma frase por regra, verificável: _"Só contam execuções com status Sucesso ou Falha."_
- Escreva o que **acontece** e os **limites** (valores, exceções), não como o código foi organizado.
- Regras também podem ficar no código, num comentário `// RN-ABC-01 texto`: o script as encontra e mostra na lista de coisas descobertas.

**Funcionalidades**

- Cada item é algo que a pessoa usuária reconhece (um card, um filtro, uma ação), com o que ele mostra ou faz.

**Diagramas (Mermaid)**

- `flowchart LR`, no máximo 10 nós por diagrama, rótulos curtos entre aspas, `<br/>` para quebrar linha.
- Mostre a **lógica de decisão** (losangos para perguntas), não a lista de arquivos.

**Canvas**

- Colunas da esquerda para a direita, na ordem do dado: **fontes → entrada → processamento → dados em memória → funções de cálculo → métricas → telas**. Use as colunas que o projeto realmente tem.
- **Toda ligação vai de uma coluna para a mesma ou uma posterior.** Nunca para trás (o script recusa).
- Um nó para cada função ou conceito que **calcula, transforma ou guarda algo**. Nós de métrica levam a **fórmula exata** e o texto de `descricao` diz o que o número significa.
- Cada métrica deve ser ligada à função que a calcula e à tela que a mostra.
- Os `id` dos nós são únicos e curtos (`c_metrics`, `m_rate`, `t_dash`).
- Use os mesmos códigos de regra (`RN-…`) do Mapa nos nós: o texto da regra é copiado de lá.
- Notas laranja (`notas`): no máximo 4, só para o que ajuda a ler o quadro ou avisos que evitam erro.
- Cores: uma por categoria de nó, contrastando entre si em fundo escuro.

**Idioma:** português do Brasil, tom direto, sem jargão desnecessário.

## Ao terminar

1. `python3 gerar_docs.py .` precisa terminar **sem erros** (os avisos "arquivo sem categoria" mostram o que ficou de fora; resolva ou justifique).
2. Responda com: quantas categorias, regras, nós e ligações, e uma lista curta do que você **não conseguiu confirmar** no código.
3. Quando o código mudar, basta rodar o comando de novo: ele relê o código e para com erro se algo citado deixou de existir.
