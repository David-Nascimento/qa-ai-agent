# Regras de migração (projeto antigo → QA AI Agent)

Valem sempre que o pedido envolver trazer código, dados ou integrações de outro projeto para este repositório.

- **Destino e origem:** este repositório é o destino. O projeto antigo é só **referência de leitura**. Nunca copie arquivos inteiros do projeto antigo por cima dos arquivos daqui.
- **Inventário primeiro:** antes de alterar código, gere `docs/migracao/inventario.md` com a tabela *origem → destino* e peça aprovação.
- **Onde fica cada coisa:**
  - integrações com Jira e Jenkins entram em `server/server.js`;
  - a interface consome o servidor só pelas rotas `/api/*` e pelos eventos SSE (veja `docs/CONTRATOS.md`).
- **Converta, não adapte a tela:** se o formato de dado do projeto antigo for diferente, converta no servidor para o contrato daqui.
- **Sem duplicar telas ou métricas:** amplie o módulo dono da informação (tabela *Onde cada informação aparece*).
- **IA:** não adicione chamadas a modelos de IA. Elementos de IA ficam ocultos com `CFG.ai = false`.
- **Segredos:** nunca no código. Use `server/.env` e documente a chave em `server/.env.example`.
- **Português do Brasil** em todo texto visível.
- **Commits:** um por item migrado, em branch `migracao/...`. Formate com Prettier só os arquivos alterados.
- **Ao concluir cada item:**
  - `cd server && npm test` passa;
  - as telas afetadas abrem sem erros no console;
  - o `README.md` está atualizado.
