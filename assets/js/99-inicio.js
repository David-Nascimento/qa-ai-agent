// QA AI Agent · Inicialização
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* Estado inicial igual ao esboço */
addUser('Quais foram as principais falhas da pipeline de Checkout nesta semana?');
addBot(KB.checkout.h + list(KB.checkout.l), KB.checkout.tip);
applyAI();
show(location.hash.slice(1));
chat.scrollTop = 0;
