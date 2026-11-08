"""Transforma uma página-fragmento (title + style + conteúdo) num HTML completo, que abre direto no navegador."""
import sys

HEAD = '''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>body{margin:0;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
'''

MERMAID = '''<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
const dark = document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
await mermaid.run({ querySelector: 'pre.mermaid' });
</script>
'''


def completo(html, links=None):
    for a, b in (links or {}).items():
        html = html.replace(a, b)
    cut = html.index('</style>') + len('</style>')
    head, body = html[:cut], html[cut:]
    extra = MERMAID if 'class="mermaid"' in body else ''
    return HEAD + head + '\n</head>\n<body>' + body + extra + '\n</body>\n</html>\n'


if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    links = dict(a.split('=>', 1) for a in sys.argv[3:])
    open(out, 'w', encoding='utf-8').write(completo(open(src, encoding='utf-8').read(), links))
