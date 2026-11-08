#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_docs.py — gera, com um comando, o MAPA DE FUNCIONALIDADES e o CANVAS DE LIGAÇÕES de um projeto.

    python3 gerar_docs.py [PROJETO]            lê o projeto e grava docs/mapa/*.html
    python3 gerar_docs.py [PROJETO] --init     cria o mapa.config.json inicial (para você ou uma IA completar)
    python3 gerar_docs.py --prompt             imprime o prompt que ensina uma IA a completar o mapa.config.json

Só usa a biblioteca padrão do Python 3.8+. Não acessa a rede (os diagramas do Mapa usam o Mermaid via CDN
ao abrir a página no navegador).

O QUE O SCRIPT DESCOBRE SOZINHO (vale para qualquer projeto JavaScript, TypeScript ou Python)
  - funções, classes, comentários acima delas e o código de cada uma;
  - quem chama quem (grafo de chamadas), que vira o Canvas e os diagramas;
  - rotas HTTP, eventos emitidos, variáveis de ambiente, chaves de armazenamento do navegador, constantes globais;
  - regras de negócio escritas em comentários no formato  // RN-ABC-01 texto da regra.

O QUE SÓ UMA PESSOA (OU UMA IA) SABE E FICA NO mapa.config.json
  - nome das categorias, regras de negócio, fórmulas das métricas, diagramas, notas e a curadoria do Canvas.
  Sem o arquivo, o script gera uma versão automática (estrutural). Com ele, gera a versão completa.

O script falha com a lista do que está errado quando o config cita função, arquivo, regra ou nó que não existe.
"""
import argparse, collections, fnmatch, html, json, os, re, sys, textwrap

VERSAO = '1.0'
EXTS_JS = ('.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx')
EXTS_PY = ('.py',)
DIRS_IGNORADOS = {'node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv', 'env', 'vendor', 'site-packages',
                  'out', 'target', 'test', 'tests', '__tests__', 'e2e', 'fixtures', 'mocks'}
PADROES_IGNORADOS = ['*.test.*', '*.spec.*', '*.min.js', '*.bundle.js', '*.d.ts', 'conftest.py']
PALETA = ['#5b9cff', '#36c2b4', '#f2a93b', '#a78bfa', '#4fd17a', '#ff7a93', '#e879f9', '#7dd3fc', '#fbbf24', '#c9ced8']
CAT_PADRAO = {
    'fonte': ('Fonte', '#f2a93b'), 'servidor': ('Servidor', '#5b9cff'), 'portal': ('Portal', '#36c2b4'),
    'dados': ('Dados', '#a78bfa'), 'calculo': ('Cálculo', '#4fd17a'), 'metrica': ('Métrica', '#ff7a93'),
    'tela': ('Tela', '#c9ced8'),
}

# ───────────────────────────── utilidades ─────────────────────────────

def ler(caminho):
    with open(caminho, encoding='utf-8', errors='replace') as f:
        return f.read()


def esc(s):
    return html.escape(str(s), quote=False)


def md(s):
    """Texto simples do config → HTML: escapa tudo e aceita `código` e **negrito**."""
    t = esc(s)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', t)
    return t.replace('\n', '<br>')


def slug(s):
    s = re.sub(r'[^a-z0-9]+', '-', s.lower().encode('ascii', 'ignore').decode() or 'x').strip('-')
    return s or 'x'


# ───────────── casamento de chaves (strings, comentários, templates e regex de JS) ─────────────

def _pular_template(src, j):
    n = len(src)
    j += 1
    while j < n:
        c = src[j]
        if c == '\\':
            j += 2
            continue
        if c == '`':
            return j + 1
        if c == '$' and src[j + 1:j + 2] == '{':
            k = casar_chaves(src, j + 1)
            if k < 0:
                return -1
            j = k
            continue
        j += 1
    return -1


def casar_chaves(src, i):
    """src[i] é '{'. Devolve o índice logo após a '}' correspondente, ou -1."""
    n, depth, j, ultimo = len(src), 0, i, ''
    while j < n:
        c = src[j]
        if c == '/' and src[j + 1:j + 2] == '/':
            k = src.find('\n', j)
            j = n if k < 0 else k
            continue
        if c == '/' and src[j + 1:j + 2] == '*':
            k = src.find('*/', j + 2)
            j = n if k < 0 else k + 2
            continue
        if c in '\'"':
            j += 1
            while j < n and src[j] != c and src[j] != '\n':
                j += 2 if src[j] == '\\' else 1
            j += 1
            ultimo = '"'
            continue
        if c == '`':
            j = _pular_template(src, j)
            if j < 0:
                return -1
            ultimo = '`'
            continue
        if c == '/' and (ultimo == '' or ultimo in '(,=:[!&|?{};'):
            k, classe = j + 1, False
            while k < n and src[k] != '\n':
                ch = src[k]
                if ch == '\\':
                    k += 2
                    continue
                if ch == '[':
                    classe = True
                elif ch == ']':
                    classe = False
                elif ch == '/' and not classe:
                    break
                k += 1
            if k < n and src[k] == '/':
                j = k + 1
                while j < n and src[j].isalpha():
                    j += 1
                ultimo = 'r'
                continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return j + 1
        if not c.isspace():
            ultimo = c
        j += 1
    return -1


def fim_da_chamada(src, fim):
    """Depois do '}' de um bloco, inclui ')' e ';' que fecham a chamada (ex.: addEventListener(..., () => {...});)."""
    k = fim
    while k < len(src) and src[k] in ');, \t':
        k += 1
    return k


def fechar_parenteses(src, i):
    depth = 0
    for j in range(i, len(src)):
        if src[j] == '(':
            depth += 1
        elif src[j] == ')':
            depth -= 1
            if depth == 0:
                return j + 1
    return -1


# ───────────────────────────── modelo do projeto ─────────────────────────────

class Fn:
    def __init__(self, arq, nome, tipo, linha, fim_linha, codigo, doc, sig):
        self.arq, self.nome, self.tipo = arq, nome, tipo
        self.linha, self.fim_linha, self.codigo, self.doc, self.sig = linha, fim_linha, codigo, doc, sig
        self.id = f'{arq}::{nome}'
        self.chama, self.chamada_por = set(), set()

    @property
    def tamanho(self):
        return self.codigo.count('\n') + 1


class Projeto:
    def __init__(self, raiz):
        self.raiz = raiz
        self.arquivos = {}    # rel -> {'linhas', 'cabecalho', 'texto'}
        self.fns = []
        self.rotas, self.eventos, self.envs, self.storage, self.consts, self.regras = [], [], {}, {}, [], []
        self.avisos = []
        self.prefixos = []


def doc_acima(linhas, idx):
    j, out = idx - 1, []
    if j >= 0 and linhas[j].strip().endswith('*/'):
        while j >= 0:
            out.append(linhas[j])
            if '/*' in linhas[j]:
                break
            j -= 1
    else:
        while j >= 0 and (linhas[j].strip().startswith('//') or linhas[j].strip().startswith('#')):
            out.append(linhas[j])
            j -= 1
    out.reverse()
    partes = []
    for l in out:
        l = re.sub(r'^\s*(/\*+|\*+/|\*|//+|#+)\s?', '', l).replace('*/', '').strip()
        if l and not l.startswith('@') and not re.match(r'^RN-[A-Z0-9]+-\d+', l):
            partes.append(l)
    txt = ' '.join(partes).strip()
    m = re.match(r'(.{20,}?[.!?])(\s|$)', txt)
    return (m.group(1) if m else txt)[:240]


RE_FN = re.compile(r'^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(', re.M)
RE_ARROW = re.compile(
    r'^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?'
    r'(?:function\b[^(\n]*\(|\([^)]*\)\s*(?::[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)', re.M)
RE_CLASS = re.compile(r'^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)', re.M)
RE_PYDEF = re.compile(r'^(?:async\s+)?def\s+(\w+)\s*\(', re.M)
RE_PYCLASS = re.compile(r'^class\s+(\w+)', re.M)


def extrair_js(rel, texto, proj):
    linhas = texto.split('\n')
    achados = []
    for rx, tipo in ((RE_FN, 'function'), (RE_ARROW, 'const'), (RE_CLASS, 'class')):
        for m in rx.finditer(texto):
            achados.append((m.start(), m.group(1), tipo, m))
    achados.sort()
    for ini, nome, tipo, m in achados:
        fim = -1
        if tipo == 'function' or (tipo == 'const' and 'function' in m.group(0)):
            p = texto.index('(', m.end() - 1) if texto[m.end() - 1] == '(' else texto.index('(', m.start())
            q = fechar_parenteses(texto, p)
            b = texto.find('{', q) if q > 0 else -1
            fim = casar_chaves(texto, b) if b > 0 else -1
        elif tipo == 'class':
            b = texto.find('{', m.end())
            fim = casar_chaves(texto, b) if b > 0 else -1
        else:  # seta
            a = texto.index('=>', m.start()) + 2
            resto = texto[a:].lstrip()
            pos = len(texto) - len(resto)
            if resto.startswith('{'):
                fim = casar_chaves(texto, pos)
            else:
                k = texto.find('\n', a)
                while 0 < k < len(texto):
                    if texto[ini:k].rstrip().endswith(';'):
                        break
                    prox = texto[k + 1:k + 2]
                    if prox and prox not in ' \t).}]?:,\n':
                        break
                    k = texto.find('\n', k + 1)
                fim = len(texto) if k < 0 else k
        if fim < 0:
            proj.avisos.append(f'{rel}: não consegui achar o fim de {nome}() — ignorada')
            continue
        fim = fim_da_chamada(texto, fim) if tipo != 'class' else fim
        codigo = texto[ini:fim].rstrip()
        l0 = texto.count('\n', 0, ini)
        sig = codigo.split('\n', 1)[0].strip()
        sig = re.sub(r'\s*\{\s*$', '', sig)
        proj.fns.append(Fn(rel, nome, tipo, l0 + 1, l0 + codigo.count('\n') + 1, codigo, doc_acima(linhas, l0), sig))


def extrair_py(rel, texto, proj):
    linhas = texto.split('\n')
    marcas = sorted([(m.start(), m.group(1), 'function') for m in RE_PYDEF.finditer(texto)] +
                    [(m.start(), m.group(1), 'class') for m in RE_PYCLASS.finditer(texto)])
    for ini, nome, tipo in marcas:
        l0 = texto.count('\n', 0, ini)
        fim_l = l0 + 1
        while fim_l < len(linhas):
            l = linhas[fim_l]
            if l.strip() and not l[0].isspace() and not l.lstrip().startswith(('#', ')', ']', '}')):
                break
            fim_l += 1
        corpo = linhas[l0:fim_l]
        while corpo and (not corpo[-1].strip() or corpo[-1].startswith(('@', '#'))):
            corpo.pop()
        codigo = '\n'.join(corpo)
        doc = ''
        md_ = re.search(r'^\s+(?:"""|\'\'\')(.*?)(?:"""|\'\'\')', codigo, re.S | re.M)
        if md_:
            doc = ' '.join(md_.group(1).split())[:240]
        else:
            doc = doc_acima(linhas, l0)
        proj.fns.append(Fn(rel, nome, tipo, l0 + 1, l0 + len(corpo), codigo, doc, corpo[0].strip().rstrip(':')))


# ───────────────────────────── varredura do projeto ─────────────────────────────

RE_ROTA = [
    re.compile(r"(?:req(?:uest)?\.method\s*===?\s*['\"](\w+)['\"]\s*&&\s*)?\w+\.pathname\s*===?\s*['\"`](/[^'\"`]*)['\"`]"),
    re.compile(r"\b(?:app|router|server|api|fastify|route)\.(get|post|put|delete|patch|all)\(\s*['\"`](/[^'\"`]*)['\"`]"),
]
RE_ROTA_PY = re.compile(r"@\w+\.(get|post|put|delete|patch|route)\(\s*['\"](/[^'\"]*)")
RE_EVENTO = re.compile(r"\b(?:emit|sendEvent|publish|broadcast|dispatchEvent|trigger)\(\s*['\"`]([\w:.\-]+)['\"`]")
RE_ENV = re.compile(r"(?<![\w.])env\.([A-Z][A-Z0-9_]*)|process\.env\.([A-Z][A-Z0-9_]*)|os\.environ(?:\.get)?[\(\[]\s*['\"]([A-Z][A-Z0-9_]*)|os\.getenv\(\s*['\"]([A-Z][A-Z0-9_]*)")
RE_STORE = re.compile(r"(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*['\"`]([^'\"`]+)['\"`]")
RE_STORE2 = re.compile(r"['\"`]([a-z]{2,10}:[A-Za-z][\w\-]*)['\"`]")
RE_CONST = re.compile(r"^(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*([\[{])", re.M)
RE_PREFIXO = re.compile(r"(?:localStorage|sessionStorage)\.\w+\(\s*['\"`]([a-z]{2,10}:)['\"`]\s*\+")
RE_REGRA = re.compile(r"(?://|#|\*)\s*(RN-[A-Z0-9]+-\d+)\s*[:\-–—]?\s*(.+)")


def listar_arquivos(raiz, ignorar, dirs_fora):
    extra = [os.path.realpath(d) for d in dirs_fora]
    for dp, dns, fns in os.walk(raiz):
        dns[:] = sorted(d for d in dns if d not in DIRS_IGNORADOS and not d.startswith('.')
                        and os.path.realpath(os.path.join(dp, d)) not in extra)
        for f in sorted(fns):
            if not f.endswith(EXTS_JS + EXTS_PY):
                continue
            rel = os.path.relpath(os.path.join(dp, f), raiz).replace(os.sep, '/')
            if any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(f, g) for g in PADROES_IGNORADOS + ignorar):
                continue
            yield rel


def varrer(raiz, ignorar=(), dirs_fora=()):
    p = Projeto(raiz)
    for rel in listar_arquivos(raiz, list(ignorar), dirs_fora):
        t = ler(os.path.join(raiz, rel))
        linhas = t.split('\n')
        cab = ''
        for l in linhas[:12]:
            s = l.strip()
            if s.startswith(('//', '#', '/*', '*')) and not s.startswith('#!') and len(s.strip('/*#- ')) > 6:
                cab = re.sub(r'^(/\*+|\*+|//+|#+)\s?', '', s).replace('*/', '').strip()
                break
        p.arquivos[rel] = {'linhas': len(linhas), 'cabecalho': cab, 'texto': t}
        (extrair_py if rel.endswith(EXTS_PY) else extrair_js)(rel, t, p)
        for i, l in enumerate(linhas, 1):
            for rx in RE_ROTA:
                for m in rx.finditer(l):
                    metodo, cam = (m.group(1) or '*').upper(), m.group(2)
                    p.rotas.append((metodo, cam, rel, i, doc_acima(linhas, i - 1)))
            for m in RE_ROTA_PY.finditer(l):
                p.rotas.append((m.group(1).upper().replace('ROUTE', '*'), m.group(2), rel, i, ''))
            for m in RE_EVENTO.finditer(l):
                p.eventos.append((m.group(1), rel, i))
            for m in RE_ENV.finditer(l):
                nome = next(g for g in m.groups() if g)
                p.envs.setdefault(nome, {'usos': [], 'desc': ''})['usos'].append((rel, i))
            for m in RE_STORE.finditer(l):
                p.storage.setdefault(m.group(1), []).append((rel, i))
            if re.search(r'\bstore\b|localStorage|sessionStorage', l):
                for m in RE_STORE2.finditer(l):
                    p.storage.setdefault(m.group(1), []).append((rel, i))
            m = RE_PREFIXO.search(l)
            if m:
                dono = next((re.search(r'(?:const|let|var)\s+(\w+)\s*=\s*\{|function\s+(\w+)', x) for x in reversed(linhas[:i]) if re.search(r'^(?:const|let|var)\s+\w+\s*=\s*\{|^function\s+\w+', x)), None)
                p.prefixos.append((m.group(1), (dono.group(1) or dono.group(2)) if dono else None, rel, i))
            m = RE_REGRA.search(l)
            if m:
                p.regras.append((m.group(1), m.group(2).strip(), rel, i))
        for m in RE_CONST.finditer(t):
            p.consts.append((m.group(1), rel, t.count('\n', 0, m.start()) + 1))
    for nome in ('.env.example', '.env.sample', 'server/.env.example', 'backend/.env.example'):
        f = os.path.join(raiz, nome)
        if os.path.isfile(f):
            desc = []
            for l in ler(f).split('\n'):
                mc = re.match(r'#\s*([A-Z][A-Z0-9_]*)=', l)  # variável opcional, documentada comentada
                if mc:
                    p.envs.setdefault(mc.group(1), {'usos': [], 'desc': ''})['desc'] = ' '.join(desc[-2:])[:200]
                    desc = []
                    continue
                if l.startswith('#'):
                    t_ = l.lstrip('# ').strip()
                    if t_ and not re.match(r'^[-=_*~ ]{2,}', t_):
                        desc.append(t_)
                    continue
                m = re.match(r'\s*([A-Z][A-Z0-9_]*)\s*=', l)
                if m:
                    p.envs.setdefault(m.group(1), {'usos': [], 'desc': ''})['desc'] = ' '.join(desc[-2:])[:200]
                desc = []
    for pref, dono, arq0, lin0 in p.prefixos:  # ex.: localStorage.getItem('qa:' + k)  →  store.get('cfg') = qa:cfg
        p.storage.pop(pref, None)
        if not dono:
            continue
        rx = re.compile(r"\b" + re.escape(dono) + r"\.(?:get|set|remove|del|delete)\(\s*['\"`]([\w.\-]+)['\"`]")
        for rel, info in p.arquivos.items():
            for i, l in enumerate(info['texto'].split('\n'), 1):
                for m in rx.finditer(l):
                    p.storage.setdefault(pref + m.group(1), []).append((rel, i))
    ligar_chamadas(p)
    return p


def ligar_chamadas(p):
    por_nome = collections.defaultdict(list)
    for f in p.fns:
        por_nome[f.nome].append(f)
    # funções com o mesmo nome no mesmo arquivo: mantém só a primeira
    vistos, unicas = set(), []
    for f in p.fns:
        if f.id in vistos:
            continue
        vistos.add(f.id)
        unicas.append(f)
    p.fns = unicas
    for f in p.fns:
        corpo = re.sub(r'/\*.*?\*/|(?<!:)//[^\n]*', '', f.codigo, flags=re.S) if not f.arq.endswith('.py') \
            else re.sub(r'#[^\n]*', '', f.codigo)
        corpo = corpo[corpo.find('\n') + 1:] if '\n' in corpo else ''
        for t in set(re.findall(r'[A-Za-z_$][\w$]*', corpo)) & por_nome.keys():
            if t == f.nome:
                continue
            e = re.escape(t)
            if not (re.search(r'(?<![\w$.])' + e + r'\s*\(', corpo) or re.search(r'[(,]\s*' + e + r'\s*[,)]', corpo)):
                continue
            cands = por_nome[t]
            mesmo = [c for c in cands if c.arq == f.arq]
            alvo = mesmo[0] if mesmo else (cands[0] if len(cands) == 1 else None)
            if alvo and alvo is not f:
                f.chama.add(alvo.id)
    por_id = {f.id: f for f in p.fns}
    for f in p.fns:
        for a in f.chama:
            por_id[a].chamada_por.add(f.id)
    p.por_id = por_id


# ───────────────────────────── resolução de trechos de código ─────────────────────────────

def trecho(p, ref, erros, onde):
    arq = ref.get('arquivo', '')
    if arq not in p.arquivos:
        arq_abs = os.path.join(p.raiz, arq)
        if os.path.isfile(arq_abs):
            p.arquivos[arq] = {'linhas': 0, 'cabecalho': '', 'texto': ler(arq_abs)}
        else:
            erros.append(f'{onde}: arquivo "{arq}" não existe')
            return None
    texto = p.arquivos[arq]['texto']
    if 'funcao' in ref:
        nome = ref['funcao']
        f = next((x for x in p.fns if x.arq == arq and x.nome == nome), None)
        if f:
            return {'f': f'{arq} · {nome}()', 'c': textwrap.dedent(f.codigo)}
        m = re.search(r'(?:async\s+)?function\s+' + re.escape(nome) + r'\s*\(|(?:const|let|var)\s+' + re.escape(nome) + r'\s*=', texto)
        if not m:
            erros.append(f'{onde}: função "{nome}" não encontrada em {arq}')
            return None
        ini = texto.rfind('\n', 0, m.start()) + 1
        b = texto.find('{', m.start())
        fim = casar_chaves(texto, b) if b > 0 else -1
        if fim < 0:
            erros.append(f'{onde}: não achei o fim de {nome}() em {arq}')
            return None
        return {'f': f'{arq} · {nome}()', 'c': textwrap.dedent(texto[ini:fim_da_chamada(texto, fim)].rstrip())}
    if 'bloco' in ref:
        i = texto.find(ref['bloco'])
        if i < 0:
            erros.append(f'{onde}: marcador "{ref["bloco"]}" não encontrado em {arq}')
            return None
        ini = texto.rfind('\n', 0, i) + 1
        b = texto.find('{', i)
        fim = casar_chaves(texto, b) if b > 0 else -1
        if fim < 0:
            erros.append(f'{onde}: bloco "{ref["bloco"]}" sem fim em {arq}')
            return None
        return {'f': arq, 'c': textwrap.dedent(texto[ini:fim_da_chamada(texto, fim)].rstrip())}
    if 'inicio' in ref:
        i = texto.find(ref['inicio'])
        if i < 0:
            erros.append(f'{onde}: marcador "{ref["inicio"]}" não encontrado em {arq}')
            return None
        ini = texto.rfind('\n', 0, i) + 1
        if 'fim' in ref:
            j = texto.find(ref['fim'], i)
            if j < 0:
                erros.append(f'{onde}: marcador final "{ref["fim"]}" não encontrado em {arq}')
                return None
            fim = texto.find('\n', j)
        else:
            j = texto.find(ref['antes_de'], i)
            if j < 0:
                erros.append(f'{onde}: marcador "{ref["antes_de"]}" não encontrado em {arq}')
                return None
            fim = texto.rfind('\n', 0, j)
        return {'f': arq, 'c': textwrap.dedent(texto[ini:(len(texto) if fim < 0 else fim)].rstrip())}
    erros.append(f'{onde}: use "funcao", "bloco" ou "inicio"/"fim"/"antes_de"')
    return None


# ───────────────────────────── agrupamento em categorias ─────────────────────────────

def agrupar(p, cfg):
    """Grupo de cada arquivo: por padrão, a pasta; pastas com muitos arquivos soltos viram um grupo por arquivo."""
    manual = cfg.get('grupos') or {}
    por_pasta = collections.defaultdict(list)
    for rel in p.arquivos:
        por_pasta[os.path.dirname(rel)].append(rel)
    grupo = {}
    for pasta, lista in por_pasta.items():
        for rel in lista:
            nome = None
            for padrao, g in manual.items():
                if fnmatch.fnmatch(rel, padrao):
                    nome = g
                    break
            if nome is None:
                if len(lista) > 8:
                    nome = os.path.splitext(os.path.basename(rel))[0]
                    nome = re.sub(r'^\d+[-_]?', '', nome) or nome
                else:
                    nome = pasta or os.path.basename(os.path.abspath(p.raiz))
            grupo[rel] = nome
    return grupo


# ───────────────────────────── Mermaid automático ─────────────────────────────

def mermaid_funcs(fns, maximo=14):
    ids = {f.id for f in fns}
    grau = {f.id: len(f.chama & ids) + len(f.chamada_por & ids) for f in fns}
    topo = [f for f in sorted(fns, key=lambda x: (-grau[x.id], x.nome)) if grau[f.id] > 0][:maximo]
    if len(topo) < 2:
        return ''
    ks = {f.id: f'n{i}' for i, f in enumerate(topo)}
    L = ['flowchart LR']
    for f in topo:
        L.append(f'  {ks[f.id]}["{f.nome}()"]')
    for f in topo:
        for a in sorted(f.chama):
            if a in ks:
                L.append(f'  {ks[f.id]} --> {ks[a]}')
    return '\n'.join(L)


def mermaid_grupos(p, grupo):
    liga = collections.Counter()
    for f in p.fns:
        for a in f.chama:
            g1, g2 = grupo.get(f.arq), grupo.get(p.por_id[a].arq)
            if g1 and g2 and g1 != g2:
                liga[(g1, g2)] += 1
    nomes = sorted(set(grupo.values()))
    if len(nomes) < 2 or not liga:
        return ''
    ks = {n: f'g{i}' for i, n in enumerate(nomes)}
    L = ['flowchart LR'] + [f'  {ks[n]}["{n}"]' for n in nomes]
    L += [f'  {ks[a]} -- "{c}" --> {ks[b]}' for (a, b), c in sorted(liga.items())]
    return '\n'.join(L)


# ───────────────────────────── regras e categorias (Mapa) ─────────────────────────────

def montar_categorias(p, cfg, grupo):
    """Devolve a lista de categorias do Mapa: as do config ou as descobertas pelo código."""
    cats = []
    if cfg.get('categorias'):
        for c in cfg['categorias']:
            cats.append(dict(c))
        return cats, False
    por_grupo = collections.defaultdict(list)
    for rel, g in grupo.items():
        por_grupo[g].append(rel)
    for g in sorted(por_grupo):
        arqs = sorted(por_grupo[g])
        fns = [f for f in p.fns if grupo.get(f.arq) == g]
        regras = [(r[0], r[1]) for r in p.regras if grupo.get(r[2]) == g]
        topo = sorted(fns, key=lambda f: (-(len(f.chama) + len(f.chamada_por)), -f.tamanho))[:25]
        cab = next((p.arquivos[a]['cabecalho'] for a in arqs if p.arquivos[a]['cabecalho']), '')
        cats.append({
            'id': slug(g), 'titulo': g, 'status': 'Descoberto', 'status_tipo': 'opt',
            'descricao': cab or f'{len(arqs)} arquivo(s) e {len(fns)} função(ões) encontrados no código.',
            'codigo': ' · '.join(f'`{a}`' for a in arqs[:6]) + (f' e mais {len(arqs) - 6}' if len(arqs) > 6 else ''),
            'diagrama': mermaid_funcs(fns),
            'funcionalidades': [[f'`{f.nome}()`', (f.doc + ' ' if f.doc else '') + f'`{f.arq}:{f.linha}`'] for f in topo],
            'regras': [list(r) for r in regras],
        })
    return cats, True


# ───────────────────────────── CANVAS ─────────────────────────────

def canvas_dados(p, cfg, grupo, regras_txt, erros, avisos, max_nos):
    cv = cfg.get('canvas') or {}
    nome = cfg.get('nome') or os.path.basename(os.path.abspath(p.raiz))
    cats = {k: {'nome': v[0], 'cor': v[1]} for k, v in CAT_PADRAO.items()} if cv.get('nos') else {}
    for k, v in (cv.get('categorias') or {}).items():
        cats[k] = {'nome': v.get('nome', k), 'cor': v.get('cor', '#aaaaaa'), 'detalhe': v.get('detalhe', 'Fórmula / detalhe')}
    dados = {'titulo': cv.get('titulo') or f'Ligações do {nome}', 'sigla': ''.join(w[0] for w in re.split(r'\W+', nome) if w)[:2].upper() or 'MP',
             'mapa': 'mapa-funcionalidades.html', 'cats': cats}
    if cv.get('nos'):
        nos, ids = [], set()
        cols = cv.get('colunas') or []
        for n in cv['nos']:
            nid = n.get('id')
            if not nid or nid in ids:
                erros.append(f'canvas: nó sem id ou repetido ({nid})')
                continue
            ids.add(nid)
            if n.get('cat') not in cats:
                erros.append(f'canvas: nó "{nid}" usa a categoria "{n.get("cat")}", que não existe em canvas.categorias')
            if not (0 <= n.get('col', -1) < len(cols)):
                erros.append(f'canvas: nó "{nid}" usa a coluna {n.get("col")}, que não existe')
            regs = []
            for r in n.get('regras', []):
                if r not in regras_txt:
                    erros.append(f'canvas: nó "{nid}" cita a regra {r}, que não existe no Mapa nem nos comentários do código')
                else:
                    regs.append({'id': r, 't': re.sub(r'`|\*\*', '', regras_txt[r])})
            cod = [t for t in (trecho(p, ref, erros, f'canvas: nó "{nid}"') for ref in n.get('codigo', [])) if t]
            nos.append({'id': nid, 'col': n.get('col', 0), 'cat': n.get('cat'), 'title': n.get('titulo', nid),
                        'where': n.get('onde', ''), 'body': n.get('descricao', ''), 'formula': n.get('formula'),
                        'fl': (cats.get(n.get('cat')) or {}).get('detalhe', 'Fórmula / detalhe'),
                        'steps': n.get('passos', []), 'rules': regs, 'code': cod, 'note': n.get('nota')})
        ord_ = {n['id']: n['col'] for n in nos}
        arestas = []
        for lig in cv.get('ligacoes', []):
            a, b = lig[0], lig[1]
            if a not in ord_ or b not in ord_:
                erros.append(f'canvas: ligação {a} → {b} cita um nó que não existe')
                continue
            if ord_[b] < ord_[a]:
                erros.append(f'canvas: ligação {a} → {b} volta para uma coluna anterior (as ligações vão da esquerda para a direita)')
                continue
            arestas.append({'a': a, 'b': b, 'l': lig[2] if len(lig) > 2 else ''})
        dados.update({'cols': cols, 'nodes': nos, 'edges': arestas,
                      'notes': [{'col': t['col'], 'text': t['texto']} for t in cv.get('notas', [])]})
        return dados
    # ─── automático: camadas pelo grafo de chamadas ───
    fns = list(p.fns)
    if not fns:
        erros.append('nenhuma função encontrada: o projeto tem arquivos .js/.ts/.py?')
        dados.update({'cols': [], 'nodes': [], 'edges': [], 'notes': []})
        return dados
    limite_util = max(6, int(0.2 * len(fns)))
    util = {f.id for f in fns if len(f.chamada_por) >= limite_util}
    cand = [f for f in fns if f.id not in util]
    ids = {f.id for f in cand}
    grau = {f.id: len((f.chama | f.chamada_por) & ids) for f in cand}
    cand = [f for f in cand if grau[f.id] > 0] if any(grau.values()) else cand
    cand = sorted(cand, key=lambda f: (-grau[f.id], -f.tamanho))[:max_nos]
    ids = {f.id for f in cand}
    # remove arestas de volta (ciclos) por busca em profundidade
    cor, ok = {}, collections.defaultdict(set)
    sys.setrecursionlimit(10000)

    def dfs(u):
        cor[u] = 1
        for v in sorted(p.por_id[u].chama & ids):
            if cor.get(v) == 1:
                continue
            ok[u].add(v)
            if v not in cor:
                dfs(v)
        cor[u] = 2
    for f in sorted(cand, key=lambda f: (len(f.chamada_por & ids), f.id)):
        if f.id not in cor:
            dfs(f.id)
    nivel = {f.id: 0 for f in cand}
    for _ in range(len(cand)):
        mudou = False
        for u, vs in ok.items():
            for v in vs:
                if nivel[v] < nivel[u] + 1:
                    nivel[v] = nivel[u] + 1
                    mudou = True
        if not mudou:
            break
    ncols = min(12, max(nivel.values()) + 1)
    nivel = {k: min(v, ncols - 1) for k, v in nivel.items()}
    grupos = sorted({grupo.get(f.arq, '?') for f in cand})
    cats = {slug(g): {'nome': g, 'cor': PALETA[i % len(PALETA)], 'detalhe': 'Assinatura'} for i, g in enumerate(grupos)}
    cols = [[f'Nível {i + 1}' + (' · pontos de entrada' if i == 0 else ''),
             'Funções que ninguém chama' if i == 0 else 'Chamadas pelo nível anterior'] for i in range(ncols)]
    regs_por_arq = collections.defaultdict(list)
    for r in p.regras:
        regs_por_arq[r[2]].append(r)
    nos = []
    for f in cand:
        regs = [{'id': r[0], 't': re.sub(r'`|\*\*', '', r[1])} for r in regs_por_arq[f.arq] if f.linha <= r[3] <= f.fim_linha]
        linhas = f.codigo.split('\n')
        corte = '\n'.join(linhas[:120]) + (f'\n// … mais {len(linhas) - 120} linhas' if len(linhas) > 120 else '')
        nos.append({'id': re.sub(r'\W', '_', f.id), 'col': nivel[f.id], 'cat': slug(grupo.get(f.arq, '?')),
                    'title': f'{f.nome}()', 'where': f'{f.arq} · linha {f.linha}',
                    'body': f.doc or 'Sem comentário no código. Escreva uma linha de comentário acima da função para ela aparecer aqui.',
                    'formula': f.sig, 'fl': 'Assinatura', 'steps': [], 'rules': regs,
                    'code': [{'f': f'{f.arq} · {f.nome}()', 'c': textwrap.dedent(corte)}], 'note': None})
    arestas = [{'a': re.sub(r'\W', '_', u), 'b': re.sub(r'\W', '_', v), 'l': ''} for u, vs in ok.items() for v in sorted(vs)]
    nota = ('GERADO AUTOMATICAMENTE\nAs colunas são níveis do grafo de chamadas: quem chama fica à esquerda.\n'
            f'Funções chamadas por muitas outras (utilitários) ficam de fora: {len(util)}.\n'
            'Para curar o Canvas (fórmulas, métricas, telas), preencha canvas.nos no mapa.config.json.')
    dados.update({'cats': cats, 'cols': cols, 'nodes': nos, 'edges': arestas, 'notes': [{'col': 0, 'text': nota}]})
    if len(fns) > len(cand):
        avisos.append(f'canvas automático mostra {len(cand)} de {len(fns)} funções (utilitários e isoladas ficam de fora; use --max-nos)')
    return dados


# ───────────────────────────── MAPA ─────────────────────────────

LEGENDA_PADRAO = [
    {'tipo': 'real', 'rotulo': 'Implementado', 'texto': 'funciona de verdade'},
    {'tipo': 'sim', 'rotulo': 'Simulado', 'texto': 'usa dados de exemplo'},
    {'tipo': 'opt', 'rotulo': 'Opcional', 'texto': 'desligado por padrão'},
    {'tipo': 'prop', 'rotulo': 'Proposta', 'texto': 'desenhado, ainda não implementado'},
]
LOGO_PADRAO = ('<svg width="30" height="27" viewBox="0 0 30 27" aria-hidden="true"><rect x="1" y="1" width="28" height="25" rx="7" '
               'fill="#7b6ff5"/><path d="M8 13h14M8 8h14M8 18h8" stroke="#e9e6ff" stroke-width="2.4" stroke-linecap="round"/></svg>')


def tabela(cab, linhas):
    if not linhas:
        return ''
    t = '<div class="table-wrap"><table><thead><tr>' + ''.join(f'<th>{esc(c)}</th>' for c in cab) + '</tr></thead><tbody>'
    for l in linhas:
        t += '<tr>' + ''.join(f'<td>{c}</td>' for c in l) + '</tr>'
    return t + '</tbody></table></div>'


def secao_descoberta(p):
    blocos = []
    rotas = sorted({(m, c, a, l, d) for m, c, a, l, d in p.rotas}, key=lambda x: (x[1], x[0]))
    vistos, lr = set(), []
    for m, c, a, l, d in rotas:
        if (m, c) in vistos:
            continue
        vistos.add((m, c))
        lr.append([f'<code>{esc(m)}</code>', f'<code>{esc(c)}</code>', esc(d) or '—', f'<code>{esc(a)}:{l}</code>'])
    if lr:
        blocos.append(('Rotas HTTP', tabela(['Método', 'Caminho', 'Descrição (comentário acima)', 'Onde'], lr)))
    ev = collections.OrderedDict()
    for n, a, l in p.eventos:
        ev.setdefault(n, []).append(f'{a}:{l}')
    if ev:
        blocos.append(('Eventos emitidos', tabela(['Evento', 'Onde'], [[f'<code>{esc(n)}</code>', ' · '.join(f'<code>{esc(x)}</code>' for x in v[:4])] for n, v in ev.items()])))
    if p.envs:
        blocos.append(('Variáveis de ambiente', tabela(['Variável', 'Descrição (.env.example)', 'Usada em'],
            [[f'<code>{esc(n)}</code>', esc(v['desc']) or '—', ' · '.join(f'<code>{esc(a)}:{l}</code>' for a, l in v['usos'][:3]) or '—']
             for n, v in sorted(p.envs.items())])))
    if p.storage:
        blocos.append(('Chaves de armazenamento do navegador', tabela(['Chave', 'Onde'],
            [[f'<code>{esc(k)}</code>', ' · '.join(f'<code>{esc(a)}:{l}</code>' for a, l in sorted(set(v))[:4])] for k, v in sorted(p.storage.items())])))
    if p.consts:
        blocos.append(('Dados globais', tabela(['Nome', 'Onde'], [[f'<code>{esc(n)}</code>', f'<code>{esc(a)}:{l}</code>'] for n, a, l in p.consts])))
    return blocos


def pagina_mapa(p, cfg, cats, auto, grupo):
    nome = cfg.get('nome') or os.path.basename(os.path.abspath(p.raiz))
    legenda = cfg.get('legenda') or LEGENDA_PADRAO
    vg = cfg.get('visao_geral') or {}
    if not vg.get('diagrama'):
        vg = dict(vg, diagrama=mermaid_grupos(p, grupo))
    nav, corpo, n = [], [], 0
    nav.append('<a href="#visao-geral"><span class="n">00</span>Visão geral</a><div class="sep"></div>')

    def cabeca(num, titulo, c):
        tag = f'<span class="tag {esc(c["status_tipo"])}">{esc(c["status"])}</span>' if c.get('status') else ''
        return f'<div class="cat-h"><span class="n">{num}</span><h2 id="t{num}">{md(titulo)}</h2>{tag}</div>'

    def diagrama(txt):
        return f'<div class="diagram"><pre class="mermaid">\n{txt}\n</pre></div>' if txt else ''

    corpo.append(f'''<section class="cat overview" aria-labelledby="t00">
      <div class="cat-h"><span class="n">00</span><h2 id="t00">{md(vg.get("titulo", "Visão geral"))}</h2></div>
      <p class="cat-desc">{md(vg.get("descricao", f"{len(p.arquivos)} arquivos, {len(p.fns)} funções e {len(p.rotas)} rotas encontrados no código."))}</p>
      {diagrama(vg.get("diagrama", ""))}
      {f'<p class="note">{md(vg["nota"])}</p>' if vg.get("nota") else ""}
    </section>''')
    todas = []
    for c in cats:
        n += 1
        num = f'{n:02d}'
        nav.append(f'<a href="#{esc(c["id"])}"><span class="n">{num}</span>{md(c["titulo"])}</a>')
        feats = ''.join(f'<dt>{md(a)}</dt><dd>{md(b)}</dd>' for a, b in c.get('funcionalidades', []))
        regras = ''.join(f'<li><span class="id">{esc(i)}</span><span>{md(t)}</span></li>' for i, t in c.get('regras', []))
        todas += c.get('regras', [])
        cols = ''
        if feats or regras:
            cols = '<div class="cols">' + (f'<div><h3>Funcionalidades</h3><dl class="feat">{feats}</dl></div>' if feats else '<div></div>') + \
                   (f'<div><h3>Regras de negócio</h3><ol class="rules">{regras}</ol></div>' if regras else '') + '</div>'
        corpo.append(f'''<section class="cat" id="{esc(c["id"])}" aria-labelledby="t{num}">
      {cabeca(num, c["titulo"], c)}
      <p class="cat-desc">{md(c.get("descricao", ""))}</p>
      {f'<p class="where">Código: {md(c["codigo"])}</p>' if c.get("codigo") else ""}
      {diagrama(c.get("diagrama", ""))}
      {f'<p class="note">{md(c["nota"])}</p>' if c.get("nota") else ""}
      {cols}
    </section>''')
    desc = secao_descoberta(p)
    if desc:
        n += 1
        num = f'{n:02d}'
        nav.append(f'<a href="#descoberto"><span class="n">{num}</span>Descoberto no código</a>')
        corpo.append(f'<section class="cat" id="descoberto" aria-labelledby="t{num}"><div class="cat-h"><span class="n">{num}</span>'
                     f'<h2 id="t{num}">Descoberto no código</h2><span class="tag opt">Automático</span></div>'
                     '<p class="cat-desc">Lido direto dos arquivos. Atualiza sozinho cada vez que o script roda.</p>' +
                     ''.join(f'<h3 style="margin:26px 0 10px">{esc(t)}</h3>{h}' for t, h in desc) + '</section>')
    if todas:
        nav.append('<div class="sep"></div><a href="#regras"><span class="n">RN</span>Todas as regras</a>')
        corpo.append('''<section class="catalog" id="regras" aria-labelledby="tRN">
      <div class="cat-h"><span class="n">RN</span><h2 id="tRN">Catálogo de regras de negócio</h2></div>
      <p class="cat-desc">Todas as regras acima numa tabela só, para consulta e auditoria.</p>
      <div class="tools">
        <label for="q" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Buscar regra</label>
        <input id="q" type="search" placeholder="Buscar por texto ou código">
        <label for="cat" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Categoria</label>
        <select id="cat"><option value="">Todas as categorias</option></select>
        <span class="count" id="count" aria-live="polite"></span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Código</th><th>Categoria</th><th>Regra</th><th>Situação</th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
    </section>''')
    leg = ''.join(f'<span><i class="tag {esc(l["tipo"])}">{esc(l["rotulo"])}</i> {md(l["texto"])}</span>' for l in legenda)
    lead = cfg.get('lead') or (f'Funcionalidades de {nome} separadas por categoria, com a lógica de cada uma' +
                               (' e as regras de negócio numeradas.' if todas else '.'))
    cab = HTML_CAB.replace('@@TITULO@@', esc(cfg.get('titulo_pagina') or f'Mapa do {nome}'))
    return (cab + CSS_MAPA + '</style>\n</head>\n<body>\n<div class="wrap">\n  <aside class="side">\n'
            f'    <div class="brand">{cfg.get("logo_svg") or LOGO_PADRAO} {esc(nome)}</div>\n'
            f'    <p class="brand-sub">{esc(cfg.get("subtitulo", "Mapa de funcionalidades"))}</p>\n'
            '    <nav aria-label="Categorias">\n      ' + '\n      '.join(nav) + '\n    </nav>\n  </aside>\n  <main>\n'
            f'    <h1 id="visao-geral">{esc(cfg.get("titulo_pagina") or f"Mapa do {nome}")}</h1>\n    <p class="lead">{md(lead)}</p>\n'
            f'    <div class="legend">{leg}</div>\n    ' + '\n\n    '.join(corpo) +
            '\n  </main>\n</div>\n<script>\n' + JS_CATALOGO + '\n</script>\n' + JS_MERMAID + '</body>\n</html>\n')


# ───────────────────────────── config inicial e prompt ─────────────────────────────

def config_inicial(p, nome, grupo):
    cats, _ = montar_categorias(p, {}, grupo)
    for c in cats:
        c['status'] = 'Implementado'
        c['status_tipo'] = 'real'
    return {
        '_ajuda': 'Complete os campos. Texto simples: `código` e **negrito** funcionam. Veja gerar_docs.py --prompt para o guia completo.',
        'nome': nome, 'subtitulo': 'Mapa de funcionalidades e regras', 'lead': '',
        'legenda': LEGENDA_PADRAO,
        'visao_geral': {'titulo': 'Visão geral da arquitetura', 'descricao': '', 'diagrama': mermaid_grupos(p, grupo), 'nota': ''},
        'categorias': cats,
        'canvas': {'auto': True, 'max_nos': 120},
    }


def principal():
    ap = argparse.ArgumentParser(description='Gera o Mapa de funcionalidades e o Canvas de ligações de um projeto.')
    ap.add_argument('projeto', nargs='?', default='.', help='pasta do projeto (padrão: a atual)')
    ap.add_argument('--config', help='arquivo de configuração (padrão: PROJETO/mapa.config.json)')
    ap.add_argument('--saida', help='pasta de saída (padrão: PROJETO/docs/mapa)')
    ap.add_argument('--so', choices=['mapa', 'canvas'], help='gera só um dos dois')
    ap.add_argument('--init', action='store_true', help='cria o mapa.config.json inicial a partir do código')
    ap.add_argument('--prompt', action='store_true', help='imprime o prompt para uma IA completar o config')
    ap.add_argument('--max-nos', type=int, default=0, help='limite de nós no Canvas automático (padrão 120)')
    ap.add_argument('--ignorar', action='append', default=[], help='padrão de arquivo a ignorar (repita para vários)')
    ap.add_argument('--estrito', action='store_true', help='avisos viram erros (bom para CI)')
    a = ap.parse_args()
    if a.prompt:
        sys.stdout.write(PROMPT)
        return 0
    raiz = os.path.abspath(a.projeto)
    if not os.path.isdir(raiz):
        print(f'Pasta não encontrada: {raiz}')
        return 2
    saida = os.path.abspath(a.saida or os.path.join(raiz, 'docs', 'mapa'))
    cfg_path = os.path.abspath(a.config or os.path.join(raiz, 'mapa.config.json'))
    cfg = {}
    if os.path.isfile(cfg_path) and not a.init:
        try:
            cfg = json.loads(ler(cfg_path))
        except ValueError as e:
            print(f'{cfg_path}: JSON inválido ({e})')
            return 2
    ign = list(cfg.get('ignorar', [])) + a.ignorar
    p = varrer(raiz, ign, [saida, os.path.dirname(os.path.abspath(__file__))])
    nome = cfg.get('nome') or os.path.basename(raiz)
    grupo = agrupar(p, cfg)
    if a.init:
        if os.path.exists(cfg_path):
            print(f'{cfg_path} já existe. Apague-o ou use --config OUTRO.json para não sobrescrever.')
            return 2
        json.dump(config_inicial(p, nome, grupo), open(cfg_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'Criado {cfg_path}\n  {len(p.arquivos)} arquivos · {len(p.fns)} funções · {len(p.rotas)} rotas · {len(p.envs)} variáveis de ambiente\n'
              'Próximo passo: complete o arquivo (você ou uma IA: python3 gerar_docs.py --prompt) e rode de novo sem --init.')
        return 0
    erros, avisos = [], list(p.avisos)
    cats, auto = montar_categorias(p, cfg, grupo)
    regras_txt = {}
    for c in cats:
        for i, t in c.get('regras', []):
            if i in regras_txt:
                erros.append(f'regra {i} aparece duas vezes no config')
            regras_txt[i] = t
    for i, t, arq, lin in p.regras:
        regras_txt.setdefault(i, t)
    if not auto:  # cobertura: arquivos que nenhuma categoria cita
        citado = ' '.join((c.get('codigo', '') + ' ' + c.get('descricao', '')) for c in cats)
        citado += ' ' + json.dumps(cfg.get('canvas', {}), ensure_ascii=False)
        for rel in sorted(p.arquivos):
            if os.path.basename(rel) not in citado and rel not in citado:
                avisos.append(f'arquivo sem categoria no Mapa: {rel}')
        ids_cfg = {r for c in cats for r, _ in c.get('regras', [])}
        for i, t, arq, lin in p.regras:
            if i not in ids_cfg:
                avisos.append(f'regra {i} está num comentário ({arq}:{lin}) mas não está no Mapa')
    max_nos = a.max_nos or (cfg.get('canvas') or {}).get('max_nos') or 120
    dados = canvas_dados(p, cfg, grupo, regras_txt, erros, avisos, max_nos) if a.so != 'mapa' else None
    if erros:
        print(f'{len(erros)} problema(s) no {os.path.basename(cfg_path)}:')
        for e in erros:
            print('  ✘', e)
        return 1
    if avisos and a.estrito:
        for w in avisos:
            print('  ✘', w)
        return 1
    os.makedirs(saida, exist_ok=True)
    saidas = []
    if a.so != 'canvas':
        f = os.path.join(saida, 'mapa-funcionalidades.html')
        open(f, 'w', encoding='utf-8').write(pagina_mapa(p, cfg, cats, auto, grupo))
        saidas.append(f'{f}  ({len(cats)} categorias · {len(regras_txt)} regras)')
    if a.so != 'mapa':
        f = os.path.join(saida, 'canvas-ligacoes.html')
        js = json.dumps(dados, ensure_ascii=False).replace('</', '<\\/')
        open(f, 'w', encoding='utf-8').write(CANVAS_TPL.replace('/*__DATA__*/null', js).replace('@@TITULO@@', esc(dados['titulo'])))
        saidas.append(f'{f}  ({len(dados["nodes"])} nós · {len(dados["edges"])} ligações · {sum(len(n["code"]) for n in dados["nodes"])} trechos de código)')
    modo = 'AUTOMÁTICO (sem mapa.config.json): rode com --init para criar o arquivo e completar' if auto or not cfg else 'a partir do mapa.config.json'
    print(f'Gerado {modo}\n  ' + '\n  '.join(saidas))
    for w in avisos:
        print('  ⚠', w)
    return 0


HTML_CAB = '''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>@@TITULO@@</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap">
<style>body{margin:0}[hidden]{display:none!important}
'''

CSS_MAPA = r'''/* Layout: documento técnico com navegação lateral fixa por categoria (empilha no celular); cada categoria = diagrama da lógica + funcionalidades + regras de negócio numeradas; no fim, catálogo único de regras com filtro */
:root{
  --bg:#f4f5f9; --surface:#ffffff; --line:#e4e6ee; --head:#f6f7fa;
  --fg:#14142b; --fg-2:#2a2b3f; --muted:#55576b;
  --ink:#1d1a40; --ink-fg:#e9e8f7; --ink-muted:#a9a6d0;
  --accent:#5b4bdb; --accent-soft:#ebe8fd; --accent-ink:#4335b8;
  --ok:#157a39; --ok-soft:#dcf5e3; --warn:#9a4a07; --warn-soft:#fff1e3; --bad:#b42323; --bad-soft:#fde2e2;
  --font:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#121126; --surface:#1b1a33; --line:#2e2c4d; --head:#232142;
  --fg:#ecebfa; --fg-2:#d5d3ee; --muted:#a3a1c2;
  --ink:#0c0b1c; --ink-fg:#e9e8f7; --ink-muted:#9a97c4;
  --accent:#8f84ff; --accent-soft:#2b2757; --accent-ink:#b7afff;
  --ok:#6fd896; --ok-soft:#173826; --warn:#f2b46b; --warn-soft:#3a2914; --bad:#ff8f8f; --bad-soft:#3d1b1f;
  color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#121126; --surface:#1b1a33; --line:#2e2c4d; --head:#232142;
  --fg:#ecebfa; --fg-2:#d5d3ee; --muted:#a3a1c2;
  --ink:#0c0b1c; --ink-fg:#e9e8f7; --ink-muted:#9a97c4;
  --accent:#8f84ff; --accent-soft:#2b2757; --accent-ink:#b7afff;
  --ok:#6fd896; --ok-soft:#173826; --warn:#f2b46b; --warn-soft:#3a2914; --bad:#ff8f8f; --bad-soft:#3d1b1f;
  color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:var(--font);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--accent-ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code,.id{font-family:var(--mono);font-size:.86em}
.wrap{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:100%}
.side{background:var(--ink);color:var(--ink-fg);padding:28px 20px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;margin-bottom:6px}
.brand-sub{color:var(--ink-muted);font-size:13px;margin:0 0 22px}
.side nav{display:flex;flex-direction:column;gap:2px}
.side nav a{color:var(--ink-fg);text-decoration:none;padding:8px 10px;border-radius:8px;font-size:14px;display:flex;gap:10px;align-items:baseline}
.side nav a:hover{background:#2a2758}
.side nav a .n{font-family:var(--mono);font-size:11.5px;color:var(--ink-muted);width:22px;flex:none}
.side nav .sep{height:1px;background:#3a3766;margin:10px 4px}
main{padding-block:36px 60px;padding-left:max(36px,env(safe-area-inset-left,0px));padding-right:max(36px,env(safe-area-inset-right,0px));min-width:0;max-width:1180px}
h1{font-size:32px;letter-spacing:-.02em;margin:0 0 8px;text-wrap:balance}
.lead{color:var(--muted);font-size:16.5px;max-width:70ch;margin:0 0 20px}
.legend{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--muted);margin-bottom:28px}
.legend span{display:inline-flex;gap:7px;align-items:center}
.tag{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;letter-spacing:.01em}
.tag.real{background:var(--ok-soft);color:var(--ok)}
.tag.sim{background:var(--warn-soft);color:var(--warn)}
.tag.prop{background:var(--accent-soft);color:var(--accent-ink)}
.tag.opt{background:var(--head);color:var(--muted);border:1px solid var(--line)}
section.cat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:26px 28px;margin-bottom:24px;scroll-margin-top:16px}
.cat-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.cat-h .n{font-family:var(--mono);font-size:13px;color:var(--accent-ink);font-weight:600}
.cat-h h2{margin:0;font-size:22px;letter-spacing:-.01em}
.cat-desc{color:var(--muted);margin:0 0 18px;max-width:75ch}
.where{font-size:13px;color:var(--muted);margin:-10px 0 18px}
.where code{background:var(--head);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.diagram{background:var(--head);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto;margin:0 0 20px}
.diagram pre.mermaid{margin:0;background:none;text-align:center;font-family:var(--font)}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:22px 32px}
h3{font-size:12.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 10px;font-weight:700}
dl.feat{margin:0;display:flex;flex-direction:column;gap:12px}
dl.feat dt{font-weight:600;color:var(--fg)}
dl.feat dd{margin:2px 0 0;color:var(--fg-2);font-size:14.5px}
ol.rules{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
ol.rules li{display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;font-size:14.5px;color:var(--fg-2)}
ol.rules .id{color:var(--accent-ink);font-weight:600;padding-top:1px}
.overview{margin-bottom:28px}
.catalog{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:26px 28px;scroll-margin-top:16px}
.tools{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:4px 0 16px}
.tools input,.tools select{font:inherit;font-size:14.5px;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:9px 12px}
.tools input{flex:1;min-width:200px;max-width:380px}
.count{color:var(--muted);font-size:13.5px;margin-left:auto}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;background:var(--head);padding:10px 12px;font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--fg-2)}
td.idc{font-family:var(--mono);font-size:12.5px;color:var(--accent-ink);font-weight:600;white-space:nowrap}
td.catc{white-space:nowrap;color:var(--muted);font-size:13px}
.empty{color:var(--muted);text-align:center;padding:24px}
.note{font-size:13.5px;color:var(--muted);border-left:3px solid var(--line);padding-left:12px;margin:16px 0 0;max-width:80ch}
@media (max-width:960px){
  .wrap{grid-template-columns:1fr}
  .side{position:static;height:auto;padding-block:20px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
  .side nav{flex-direction:row;flex-wrap:wrap}
  .side nav .sep{display:none}
  main{padding-block:24px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
  .cols{grid-template-columns:1fr}
  section.cat,.catalog{padding:20px 18px}
  ol.rules li{grid-template-columns:1fr;gap:2px}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
html{scroll-behavior:smooth}'''
JS_CATALOGO = r'''(function(){
  // Monta o catálogo a partir das regras escritas em cada categoria (uma única fonte)
  var rows=[], sel=document.getElementById('cat'), tbody=document.getElementById('rows');
  document.querySelectorAll('section.cat[id]').forEach(function(sec){
    var name=sec.querySelector('h2'); if(!name) return;
    var tag=sec.querySelector('.cat-h .tag'); var status=tag?tag.textContent:'';
    var cls=tag?tag.className.replace('tag','').trim():'';
    var items=sec.querySelectorAll('ol.rules li'); if(!items.length) return;
    var opt=document.createElement('option'); opt.value=sec.id; opt.textContent=name.textContent; sel.appendChild(opt);
    items.forEach(function(li){
      var tr=document.createElement('tr'); tr.dataset.cat=sec.id;
      var id=li.querySelector('.id').textContent, txt=li.children[1];
      tr.innerHTML='<td class="idc"></td><td class="catc"></td><td></td><td><span class="tag '+cls+'"></span></td>';
      tr.children[0].textContent=id; tr.children[1].textContent=name.textContent;
      tr.children[2].innerHTML=txt.innerHTML; tr.children[3].firstChild.textContent=status;
      tr.dataset.text=(id+' '+txt.textContent+' '+name.textContent).toLowerCase();
      tbody.appendChild(tr); rows.push(tr);
    });
  });
  var empty=document.createElement('tr'); empty.innerHTML='<td colspan="4" class="empty">Nenhuma regra encontrada.</td>'; empty.hidden=true; tbody.appendChild(empty);
  function apply(){
    var q=document.getElementById('q').value.trim().toLowerCase(), c=sel.value, n=0;
    rows.forEach(function(r){var ok=(!c||r.dataset.cat===c)&&(!q||r.dataset.text.indexOf(q)>-1); r.hidden=!ok; if(ok)n++;});
    empty.hidden=n>0; document.getElementById('count').textContent=n+' de '+rows.length+' regras';
  }
  document.getElementById('q').addEventListener('input',apply); sel.addEventListener('change',apply); apply();
})();'''
JS_MERMAID = r'''<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
const dark = document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
await mermaid.run({ querySelector: 'pre.mermaid' });
</script>
'''
CANVAS_TPL = r'''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>@@TITULO@@</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{
  color-scheme:dark;
  --bg:#0f1115; --dot:#262a33; --panel:#171a21; --panel2:#1d2129; --line:#2a2f3a; --line2:#353b48;
  --fg:#e8eaef; --fg2:#a9afbc; --fg3:#737a89;
  --ok:#4fd17a; --hot:#ff7a93; --accent:#5b9cff;
  --note:#f59e3b; --note-bg:#3a2a12; --note-fg:#ffe2bd;
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 var(--sans);overflow:hidden}
button,input{font:inherit;color:inherit}
#vp{position:fixed;inset:0;overflow:hidden;cursor:grab;touch-action:none;
  background-color:var(--bg);background-image:radial-gradient(var(--dot) 1.2px,transparent 1.3px);background-size:22px 22px}
#vp.drag{cursor:grabbing}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
#wires{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
#wires path{fill:none;stroke-width:1.5;transition:opacity .15s}
#wires path.loop{stroke-dasharray:5 5}
#wires .lbl rect{fill:var(--panel2);stroke:var(--line2)}
#wires .lbl text{fill:var(--fg2);font:11px var(--sans)}
.colh{position:absolute;top:0;width:300px}
.colh b{display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg)}
.colh span{font-size:12px;color:var(--fg3)}
.colh i{display:block;height:2px;width:36px;margin-top:8px;border-radius:2px}
.node{position:absolute;width:300px;background:var(--panel);border:1px solid var(--line);border-radius:12px;
  box-shadow:0 6px 18px rgba(0,0,0,.35);cursor:pointer;transition:opacity .15s,border-color .15s,box-shadow .15s}
.node:hover{border-color:var(--line2)}
.node:focus-visible{outline:2px solid var(--k);outline-offset:3px}
.node.sel{border-color:var(--k);box-shadow:0 0 0 1px var(--k),0 10px 30px rgba(0,0,0,.5)}
.node .hd{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);font-size:11px;
  letter-spacing:.07em;text-transform:uppercase;color:var(--k);font-weight:600}
.node .hd .sq{width:8px;height:8px;border-radius:2px;background:var(--k)}
.node .hd .n{margin-left:auto;color:var(--fg3);font-weight:500;letter-spacing:0;text-transform:none}
.node .bd{padding:10px 12px 12px;display:grid;gap:6px}
.node h3{margin:0;font-size:15px;font-weight:600;line-height:1.3;text-wrap:balance}
.node .wh{font:11px/1.4 var(--mono);color:var(--fg3);word-break:break-word}
.node p{margin:0;color:var(--fg2);font-size:12.5px}
.node .fx{margin:2px 0 0;padding:7px 9px;background:#0b0d11;border:1px solid var(--line);border-radius:7px;
  font:11px/1.5 var(--mono);color:#d8dce4;white-space:pre-wrap;word-break:break-word}
.node .chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{font:10.5px var(--mono);padding:2px 6px;border-radius:5px;background:var(--panel2);border:1px solid var(--line);color:var(--fg2)}
.chip.code{color:var(--ok)}
.port{position:absolute;top:15px;width:10px;height:10px;border-radius:50%;background:var(--bg);border:2px solid var(--k)}
.port.in{left:-6px}.port.out{right:-6px}
.note{position:absolute;width:300px;padding:12px 14px;background:var(--note-bg);border:1px solid var(--note);border-radius:10px;
  color:var(--note-fg);font-size:12.5px;white-space:pre-line;box-shadow:0 6px 18px rgba(0,0,0,.35)}
.note::first-line{font-weight:700;letter-spacing:.06em;color:var(--note)}
.dim{opacity:.13}
/* barra superior */
#top{position:fixed;left:0;right:0;top:0;z-index:20;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;
  padding-block:calc(10px + env(safe-area-inset-top,0px)) 10px;
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));
  background:linear-gradient(var(--bg) 60%,transparent);pointer-events:none}
#top>*{pointer-events:auto}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.brand .lg{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:var(--panel2);border:1px solid var(--line2);
  font:600 12px var(--mono);color:var(--accent)}
.brand b{display:block;font-size:14px}
.brand small{color:var(--fg3);font-size:12px}
.srch{position:relative;flex:1 1 220px;max-width:340px}
.srch input{width:100%;padding:8px 12px;border-radius:9px;background:var(--panel);border:1px solid var(--line2);outline:none}
.srch input:focus{border-color:var(--accent)}
#res{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--panel);border:1px solid var(--line2);border-radius:10px;
  overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,.5)}
#res button{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;background:none;border:0;padding:8px 12px;cursor:pointer}
#res button:hover,#res button:focus{background:var(--panel2);outline:none}
#res small{color:var(--fg3);font:11px var(--mono);margin-left:auto;white-space:nowrap}
.legend{display:flex;gap:6px;overflow-x:auto;max-width:100%;scrollbar-width:none}
.legend button{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:var(--panel);border:1px solid var(--line);
  font-size:12px;color:var(--fg2);cursor:pointer;white-space:nowrap}
.legend button i{width:8px;height:8px;border-radius:2px;background:var(--k)}
.legend button.on{border-color:var(--k);color:var(--fg)}
.lnk{margin-left:auto;font-size:12.5px;color:var(--fg2);text-decoration:none;padding:6px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--panel)}
.lnk:hover{color:var(--fg)}
/* barra de zoom */
#zoom{position:fixed;z-index:20;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));
  display:flex;align-items:center;gap:2px;padding:4px;background:var(--panel);border:1px solid var(--line2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.45)}
#zoom button{min-width:34px;height:32px;border:0;border-radius:8px;background:none;cursor:pointer;color:var(--fg2);padding:0 10px}
#zoom button:hover{background:var(--panel2);color:var(--fg)}
#zoom button.on{color:var(--fg);background:var(--panel2)}
#zoom .pc{min-width:52px;text-align:center;font:12px var(--mono);color:var(--fg3)}
#zoom .sep{width:1px;height:20px;background:var(--line2);margin:0 4px}
/* painel lateral */
#dr{position:fixed;z-index:30;top:0;right:0;bottom:0;width:min(480px,100%);background:var(--panel);border-left:1px solid var(--line2);
  transform:translateX(100%);transition:transform .2s ease;display:flex;flex-direction:column;box-shadow:-20px 0 40px rgba(0,0,0,.4)}
#dr.open{transform:none}
#dr header{display:flex;align-items:flex-start;gap:10px;padding:calc(16px + env(safe-area-inset-top,0px)) max(18px,env(safe-area-inset-right,0px)) 14px 18px;border-bottom:1px solid var(--line)}
#dr header .t{flex:1;min-width:0}
#dr .ty{font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;color:var(--k)}
#dr h2{margin:4px 0 4px;font-size:19px;line-height:1.25;text-wrap:balance}
#dr .wh{font:12px/1.4 var(--mono);color:var(--fg3);word-break:break-word}
#dr .x{border:1px solid var(--line2);background:var(--panel2);width:32px;height:32px;border-radius:8px;cursor:pointer;flex:none}
#dr .sc{overflow-y:auto;padding:16px 18px calc(28px + env(safe-area-inset-bottom,0px));padding-right:max(18px,env(safe-area-inset-right,0px));display:grid;gap:20px;align-content:start}
#dr section{display:grid;gap:8px;min-width:0}
#dr h4{margin:0;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--fg3);font-weight:600}
#dr p{margin:0;color:var(--fg2);max-width:65ch}
#dr .fx{margin:0;padding:10px 12px;background:#0b0d11;border:1px solid var(--line);border-radius:9px;font:12px/1.6 var(--mono);white-space:pre-wrap;word-break:break-word}
#dr ol{margin:0;padding-left:20px;color:var(--fg2);display:grid;gap:5px}
#dr .warn{padding:9px 12px;border-radius:9px;background:var(--note-bg);border:1px solid var(--note);color:var(--note-fg);font-size:13px}
.io{display:grid;gap:4px}
.io button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 10px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);cursor:pointer}
.io button:hover{border-color:var(--line2)}
.io button i{width:8px;height:8px;border-radius:2px;background:var(--k);flex:none}
.io button small{margin-left:auto;color:var(--fg3);font-size:11.5px;text-align:right}
.io .none{color:var(--fg3);font-size:13px}
.rn{display:grid;gap:6px}
.rn div{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:8px 10px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);font-size:13px;color:var(--fg2)}
.rn b{font:500 11px var(--mono);color:var(--hot);white-space:nowrap;padding-top:2px}
details.cd{border:1px solid var(--line);border-radius:9px;background:#0b0d11;min-width:0}
details.cd summary{cursor:pointer;padding:8px 12px;font:12px var(--mono);color:var(--ok);list-style:none;display:flex;gap:8px}
details.cd summary::before{content:'▸';color:var(--fg3)}
details.cd[open] summary::before{content:'▾'}
details.cd pre{margin:0;padding:10px 12px;border-top:1px solid var(--line);overflow-x:auto;font:11.5px/1.55 var(--mono);color:#d8dce4;max-height:460px}
.kw{color:#c792ea}.st{color:#c3e88d}.cm{color:#6b7385;font-style:italic}.nu{color:#f78c6c}
@media (max-width:640px){
  .lnk{display:none}
  #dr{top:auto;height:82%;width:100%;border-left:0;border-top:1px solid var(--line2);border-radius:16px 16px 0 0;transform:translateY(100%)}
  #dr header{padding-top:16px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>

<div id="vp" aria-label="Canvas de ligações"><div id="world"><svg id="wires"></svg></div></div>

<div id="top">
  <div class="brand"><div class="lg" id="sig"></div><div><b id="ttl"></b><small id="cnt"></small></div></div>
  <div class="srch"><input id="q" type="search" placeholder="Buscar função, métrica ou tela…" autocomplete="off" aria-label="Buscar no canvas"><div id="res" hidden></div></div>
  <div class="legend" id="leg"></div>
  <a class="lnk" id="lnkmapa" href="mapa-funcionalidades.html">Mapa de funcionalidades ↗</a>
</div>

<div id="zoom">
  <button id="zo" aria-label="Diminuir zoom">−</button><span class="pc" id="zp">100%</span><button id="zi" aria-label="Aumentar zoom">+</button>
  <span class="sep"></span><button id="zf">Ajustar</button><button id="zl" aria-pressed="false">Rótulos</button>
</div>

<aside id="dr" aria-label="Detalhes do nó"><header><div class="t"><div class="ty" id="dty"></div><h2 id="dt"></h2><div class="wh" id="dw"></div></div>
  <button class="x" id="dx" aria-label="Fechar">✕</button></header><div class="sc" id="dc"></div></aside>

<script>
const D = /*__DATA__*/null;
const CAT = Object.fromEntries(Object.entries(D.cats).map(([k, v]) => [k, { n: v.nome }]));
const W = 300, CW = 400, TOP = 96, GAP = 26;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const kvar = c => (D.cats[c] && D.cats[c].cor) || '#aaaaaa';
const byId = Object.fromEntries(D.nodes.map(n => [n.id, n]));
const ins = {}, outs = {};
D.nodes.forEach(n => { ins[n.id] = []; outs[n.id] = []; });
D.edges.forEach(e => { outs[e.a].push(e); ins[e.b].push(e); });

$('#ttl').textContent = D.titulo; $('#sig').textContent = D.sigla; if (!D.mapa) $('#lnkmapa').hidden = true;
document.title = D.titulo;
$('#cnt').textContent = `${D.nodes.length} nós · ${D.edges.length} ligações · ${D.nodes.reduce((s, n) => s + n.code.length, 0)} trechos de código`;

// ---------- montar nós
const world = $('#world'), svg = $('#wires');
D.cols.forEach(([t, s], i) => {
  const h = document.createElement('div');
  h.className = 'colh'; h.style.left = (40 + i * CW) + 'px';
  h.innerHTML = `<b>${esc(t)}</b><span>${esc(s)}</span><i style="background:var(--fg3)"></i>`;
  world.appendChild(h);
});
D.nodes.forEach(n => {
  const el = document.createElement('div');
  el.className = 'node'; el.tabIndex = 0; el.dataset.id = n.id;
  el.style.setProperty('--k', kvar(n.cat));
  el.setAttribute('role', 'button'); el.setAttribute('aria-label', `${CAT[n.cat].n}: ${n.title}`);
  const chips = [...n.rules.slice(0, 4).map(r => `<span class="chip">${r.id}</span>`),
    n.rules.length > 4 ? `<span class="chip">+${n.rules.length - 4}</span>` : '',
    n.code.length ? `<span class="chip code">{ } ${n.code.length} função${n.code.length > 1 ? 'ões' : ''}</span>` : ''].join('');
  el.innerHTML = `<span class="port in"></span><span class="port out"></span>
    <div class="hd"><span class="sq"></span>${CAT[n.cat].n}<span class="n">${ins[n.id].length} → ${outs[n.id].length}</span></div>
    <div class="bd"><h3>${esc(n.title)}</h3>${n.where ? `<div class="wh">${esc(n.where)}</div>` : ''}
    <p>${esc(n.body)}</p>${n.formula ? `<div class="fx">${esc(n.formula)}</div>` : ''}${chips ? `<div class="chips">${chips}</div>` : ''}</div>`;
  if (!ins[n.id].length) el.querySelector('.in').remove();
  if (!outs[n.id].length) el.querySelector('.out').remove();
  el.addEventListener('click', ev => { if (!moved) select(n.id, false); });
  el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id, true); } });
  n.el = el; world.appendChild(el);
});
const notes = D.notes.map(t => {
  const el = document.createElement('div'); el.className = 'note'; el.textContent = t.text; world.appendChild(el); return {...t, el};
});

// ---------- layout: barycentro dos pais para reduzir cruzamentos
function layout() {
  const cols = D.cols.map((_, i) => D.nodes.filter(n => n.col === i));
  let maxH = 0;
  cols.forEach((list, i) => {
    if (i > 0) {
      list.forEach((n, k) => {
        const ps = ins[n.id].map(e => byId[e.a]).filter(p => p.col < i && p.y != null);
        n.bc = ps.length ? ps.reduce((s, p) => s + p.y + p.h / 2, 0) / ps.length : 1e6 + k;
      });
      list.sort((a, b) => a.bc - b.bc);
    }
    let y = TOP;
    list.forEach(n => { n.x = 40 + i * CW; n.h = n.el.offsetHeight; n.y = y; y += n.h + GAP; });
    notes.filter(t => t.col === i).forEach(t => { t.x = 40 + i * CW; t.y = y + 10; y += t.el.offsetHeight + GAP + 10; });
    maxH = Math.max(maxH, y);
  });
  D.nodes.forEach(n => { n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; });
  notes.forEach(t => { t.el.style.left = t.x + 'px'; t.el.style.top = t.y + 'px'; });
  world.style.width = (40 + D.cols.length * CW) + 'px'; world.style.height = maxH + 'px';
  bounds = { w: 40 + D.cols.length * CW, h: maxH };
  drawWires();
}

let bounds = { w: 1, h: 1 }, labels = false, selId = null, lit = null;
function geom(e) {
  const a = byId[e.a], b = byId[e.b];
  const y1 = a.y + 20, y2 = b.y + 20;
  if (a.col === b.col) {
    const x = a.x + W, bend = 46 + Math.min(60, Math.abs(y2 - y1) / 10);
    return { d: `M${x},${y1} C${x + bend},${y1} ${x + bend},${y2} ${x},${y2}`, loop: true, mx: x + bend * .75, my: (y1 + y2) / 2 };
  }
  const x1 = a.x + W, x2 = b.x, dx = Math.max(70, (x2 - x1) / 2);
  const p = [[x1, y1], [x1 + dx, y1], [x2 - dx, y2], [x2, y2]];
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
    mx: (p[0][0] + 3 * p[1][0] + 3 * p[2][0] + p[3][0]) / 8, my: (p[0][1] + 3 * p[1][1] + 3 * p[2][1] + p[3][1]) / 8 };
}
function drawWires() {
  svg.setAttribute('width', bounds.w); svg.setAttribute('height', bounds.h);
  let h = '', lb = '';
  D.edges.forEach((e, i) => {
    const g = geom(e), on = !lit || (lit.has(e.a) && lit.has(e.b));
    const strong = lit && on;
    h += `<path class="${g.loop ? 'loop' : ''}" d="${g.d}" stroke="${kvar(byId[e.a].cat)}" stroke-width="${strong ? 2.2 : 1.5}" opacity="${!lit ? .5 : on ? 1 : .05}"/>`;
    if (e.l && (labels || strong)) {
      const w = e.l.length * 6 + 14;
      lb += `<g class="lbl"><rect x="${g.mx - w / 2}" y="${g.my - 10}" width="${w}" height="20" rx="6"/><text x="${g.mx}" y="${g.my + 4}" text-anchor="middle">${esc(e.l)}</text></g>`;
    }
  });
  svg.innerHTML = h + lb;
}

// ---------- câmera
const vp = $('#vp'); let cam = { x: 0, y: 0, k: 1 };
function apply() { world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.k})`; $('#zp').textContent = Math.round(cam.k * 100) + '%'; }
function zoomAt(k, cx, cy) {
  k = Math.min(2.2, Math.max(.12, k));
  cam.x = cx - (cx - cam.x) * (k / cam.k); cam.y = cy - (cy - cam.y) * (k / cam.k); cam.k = k; apply();
}
function fit(widthOnly) {
  const r = vp.getBoundingClientRect(), padT = $('#top').offsetHeight + 10, padB = 70;
  const kw = (r.width - 40) / bounds.w, kh = (r.height - padT - padB) / bounds.h;
  const k = Math.min(1, Math.max(.12, widthOnly === true ? Math.max(kw, .3) : Math.min(kw, kh)));
  cam = { k, x: Math.max(20, (r.width - bounds.w * k) / 2), y: padT }; apply();
}
function centerOn(n) {
  const r = vp.getBoundingClientRect(), k = Math.max(cam.k, .85);
  const drawer = $('#dr').classList.contains('open') && r.width > 640 ? $('#dr').offsetWidth : 0;
  const bottom = r.width <= 640 && $('#dr').classList.contains('open') ? r.height * .82 : 0;
  cam.k = k; cam.x = (r.width - drawer) / 2 - (n.x + W / 2) * k; cam.y = (r.height - bottom) / 2 - (n.y + Math.min(n.h, 260) / 2) * k + (bottom ? 20 : 0); apply();
}
vp.addEventListener('wheel', ev => {
  ev.preventDefault();
  if (ev.ctrlKey || Math.abs(ev.deltaY) > 0 && !ev.shiftKey && Math.abs(ev.deltaX) < 1 && ev.deltaMode !== 0 || ev.ctrlKey) {}
  if (ev.ctrlKey || !ev.deltaX && Math.abs(ev.deltaY) >= 40) zoomAt(cam.k * Math.exp(-ev.deltaY * (ev.ctrlKey ? .01 : .0015)), ev.clientX, ev.clientY);
  else { cam.x -= ev.deltaX; cam.y -= ev.deltaY; apply(); }
}, { passive: false });
const ptrs = new Map(); let moved = false, start = null, pinch = null;
vp.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  moved = false; start = { x: ev.clientX, y: ev.clientY, cx: cam.x, cy: cam.y };
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.k }; }
});
window.addEventListener('pointermove', ev => {
  if (!ptrs.has(ev.pointerId)) return;
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()];
    zoomAt(pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2); moved = true; return;
  }
  const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
  if (!moved && Math.hypot(dx, dy) > 4) { moved = true; vp.classList.add('drag'); try { vp.setPointerCapture(ev.pointerId); } catch {} }
  if (moved) { cam.x = start.cx + dx; cam.y = start.cy + dy; apply(); }
});
const up = ev => {
  ptrs.delete(ev.pointerId); if (ptrs.size < 2) pinch = null;
  vp.classList.remove('drag');
  if (!moved && ev.target === vp || ev.target === world) { if (!moved) clearSel(); }
  setTimeout(() => { if (!ptrs.size) moved = false; }, 0);
};
window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
$('#zi').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(cam.k * 1.2, r.width / 2, r.height / 2); };
$('#zo').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(cam.k / 1.2, r.width / 2, r.height / 2); };
$('#zf').onclick = () => fit();
$('#zl').onclick = () => { labels = !labels; $('#zl').classList.toggle('on', labels); $('#zl').setAttribute('aria-pressed', labels); drawWires(); };

// ---------- destaque do caminho
function walk(id, dir) {
  const seen = new Set([id]), st = [id];
  while (st.length) { const c = st.pop(); (dir === 'up' ? ins[c] : outs[c]).forEach(e => { const nx = dir === 'up' ? e.a : e.b; if (!seen.has(nx)) { seen.add(nx); st.push(nx); } }); }
  return seen;
}
function paint() {
  D.nodes.forEach(n => { n.el.classList.toggle('dim', !!lit && !lit.has(n.id)); n.el.classList.toggle('sel', n.id === selId); });
  notes.forEach(t => t.el.classList.toggle('dim', !!lit));
  drawWires();
}
let catOn = null;
function clearSel() {
  selId = null; lit = null; catOn = null; $('#dr').classList.remove('open');
  document.querySelectorAll('.legend button').forEach(b => b.classList.remove('on'));
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  paint();
}

// ---------- realce de código
function hl(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|\b(const|let|var|function|async|await|return|if|else|for|of|in|while|new|try|catch|throw|break|continue|null|true|false|undefined|typeof|switch|case|default)\b|\b(\d+(?:\.\d+)?)\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    out += `<span class="${m[1] ? 'cm' : m[2] ? 'st' : m[3] ? 'kw' : 'nu'}">${esc(m[0])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}

// ---------- painel
function ioList(list, key) {
  if (!list.length) return '<div class="none">Nenhuma</div>';
  return list.map(e => { const o = byId[e[key]];
    return `<button data-go="${o.id}" style="--k:${kvar(o.cat)}"><i></i><span>${esc(o.title)}</span><small>${esc(e.l || CAT[o.cat].n)}</small></button>`; }).join('');
}
function select(id, center) {
  const n = byId[id]; if (!n) return;
  selId = id; catOn = null;
  document.querySelectorAll('.legend button').forEach(b => b.classList.remove('on'));
  lit = new Set([...walk(id, 'up'), ...walk(id, 'down')]);
  paint();
  const dr = $('#dr'); dr.style.setProperty('--k', kvar(n.cat));
  $('#dty').textContent = CAT[n.cat].n + ' · coluna ' + (n.col + 1) + ' · ' + D.cols[n.col][0];
  $('#dt').textContent = n.title; $('#dw').textContent = n.where; $('#dw').hidden = !n.where;
  const up = walk(id, 'up').size - 1, dn = walk(id, 'down').size - 1;
  let h = `<section><h4>O que faz</h4><p>${esc(n.body)}</p></section>`;
  if (n.note) h += `<div class="warn">${esc(n.note)}</div>`;
  if (n.formula) h += `<section><h4>${esc(n.fl || 'Fórmula')}</h4><pre class="fx">${esc(n.formula)}</pre></section>`;
  if (n.steps.length) h += `<section><h4>Passo a passo</h4><ol>${n.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></section>`;
  h += `<section><h4>Recebe de (${ins[id].length})</h4><div class="io">${ioList(ins[id], 'a')}</div></section>`;
  h += `<section><h4>Envia para (${outs[id].length})</h4><div class="io">${ioList(outs[id], 'b')}</div></section>`;
  h += `<section><h4>Caminho completo</h4><p>${up} nó${up === 1 ? '' : 's'} antes e ${dn} depois deste estão acesos no canvas.</p></section>`;
  if (n.rules.length) h += `<section><h4>Regras de negócio</h4><div class="rn">${n.rules.map(r => `<div><b>${r.id}</b><span>${esc(r.t)}</span></div>`).join('')}</div></section>`;
  if (n.code.length) h += `<section><h4>Código real (${n.code.length})</h4>${n.code.map((c, i) => `<details class="cd"${i === 0 ? ' open' : ''}><summary>${esc(c.f)}</summary><pre>${hl(c.c)}</pre></details>`).join('')}</section>`;
  $('#dc').innerHTML = h; $('#dc').scrollTop = 0;
  dr.classList.add('open');
  try { history.replaceState(null, '', '#' + id.replace(/_/g, '-')); } catch {}
  if (center) centerOn(n);
}
$('#dc').addEventListener('click', ev => { const b = ev.target.closest('[data-go]'); if (b) select(b.dataset.go, true); });
$('#dx').onclick = clearSel;
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { $('#res').hidden = true; clearSel(); } });

// ---------- legenda
Object.entries(CAT).forEach(([k, v]) => {
  const b = document.createElement('button'); b.style.setProperty('--k', kvar(k));
  b.innerHTML = `<i></i>${v.n} <span style="color:var(--fg3)">${D.nodes.filter(n => n.cat === k).length}</span>`;
  b.onclick = () => {
    if (catOn === k) return clearSel();
    selId = null; catOn = k; $('#dr').classList.remove('open');
    lit = new Set(D.nodes.filter(n => n.cat === k).map(n => n.id));
    document.querySelectorAll('.legend button').forEach(x => x.classList.toggle('on', x === b)); paint();
  };
  $('#leg').appendChild(b);
});

// ---------- busca
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
$('#q').addEventListener('input', () => {
  const q = norm($('#q').value.trim()), res = $('#res');
  if (!q) { res.hidden = true; return; }
  const hits = D.nodes.map(n => {
    const t = norm(n.title), hay = norm([n.where, n.body, n.formula || '', n.code.map(c => c.f).join(' '), n.rules.map(r => r.id).join(' ')].join(' '));
    return { n, s: t.includes(q) ? (t.startsWith(q) ? 3 : 2) : hay.includes(q) ? 1 : 0 };
  }).filter(h => h.s).sort((a, b) => b.s - a.s).slice(0, 8);
  res.innerHTML = hits.length ? hits.map(h => `<button data-id="${h.n.id}" style="--k:${kvar(h.n.cat)}"><span>${esc(h.n.title)}</span><small>${CAT[h.n.cat].n}</small></button>`).join('')
    : '<button disabled><span style="color:var(--fg3)">Nada encontrado</span></button>';
  res.hidden = false;
});
$('#q').addEventListener('keydown', ev => { if (ev.key === 'Enter') { const b = $('#res button[data-id]'); if (b) b.click(); } });
$('#res').addEventListener('click', ev => { const b = ev.target.closest('[data-id]'); if (!b) return; $('#res').hidden = true; $('#q').blur(); select(b.dataset.id, true); });
document.addEventListener('pointerdown', ev => { if (!ev.target.closest('.srch')) $('#res').hidden = true; });

// ---------- início
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
  layout(); fit(true);
  const h = location.hash.slice(1).replace(/-/g, '_');
  if (byId[h]) select(h, true);
});
window.addEventListener('resize', () => { if (!selId) fit(true); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1).replace(/-/g, '_'); if (byId[h] && h !== selId) select(h, true); });
</script>

</body>
</html>
'''
PROMPT = r'''# Prompt: completar o mapa.config.json de um projeto

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
    {"tipo": "real", "rotulo": "Implementado", "texto": "funciona de verdade"},
    {"tipo": "sim",  "rotulo": "Simulado",     "texto": "usa dados de exemplo"},
    {"tipo": "opt",  "rotulo": "Opcional",     "texto": "desligado por padrão"},
    {"tipo": "prop", "rotulo": "Proposta",     "texto": "desenhado, ainda não implementado"}
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
      "fonte":   {"nome": "Fonte",   "cor": "#f2a93b", "detalhe": "Formato"},
      "calculo": {"nome": "Cálculo", "cor": "#4fd17a", "detalhe": "Fórmula"}
    },
    "colunas": [["Fontes e gatilhos", "De onde os dados nascem"], ["Funções de cálculo", "Onde as métricas são calculadas"]],
    "nos": [
      {
        "id": "c_metrics", "col": 1, "cat": "calculo",
        "titulo": "Indicadores do período",
        "onde": "50-analises.js · metrics()",
        "descricao": "O que o nó faz, em 1 ou 2 frases.",
        "formula": "taxa = ok ÷ n × 100",
        "passos": ["Passo 1", "Passo 2"],
        "regras": ["RN-ANA-02"],
        "nota": "Aviso (opcional).",
        "codigo": [{"arquivo": "assets/js/50-analises.js", "funcao": "metrics"}]
      }
    ],
    "ligacoes": [["src_jenkins", "c_metrics", "builds"], ["c_metrics", "m_rate"]],
    "notas": [{"col": 0, "texto": "COMO LER\nPrimeira linha em destaque; as demais explicam."}]
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
- Uma frase por regra, verificável: *"Só contam execuções com status Sucesso ou Falha."*
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
'''

if __name__ == '__main__':
    sys.exit(principal())
