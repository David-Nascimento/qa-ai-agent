// QA AI Agent · Agente de QA (só aparece com Recursos de IA ligado)
// Scripts clássicos carregados em ordem pelo index.html (escopo global compartilhado).

/* ---------- 7. Agente de IA ---------- */
const BOT_AV =
  '<div class="av"><svg width="30" height="28" viewBox="0 0 42 38" aria-hidden="true"><rect x="19.5" y="1" width="3" height="6" rx="1.5" fill="#6d5ef0"/><circle cx="21" cy="2.5" r="2.5" fill="#6d5ef0"/><rect x="0" y="16" width="5" height="11" rx="2.5" fill="#6d5ef0"/><rect x="37" y="16" width="5" height="11" rx="2.5" fill="#6d5ef0"/><rect x="4" y="7" width="34" height="28" rx="10" fill="#6d5ef0"/><rect x="9" y="13" width="24" height="16" rx="7" fill="#fff"/><circle cx="16" cy="21" r="3" fill="#3d32b8"/><circle cx="26" cy="21" r="3" fill="#3d32b8"/></svg></div>';
const USER_AV =
  '<div class="av">' +
  svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>', 24, '#5b4bdb') +
  '</div>';
const TIP_IC =
  '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6v1.5a2.5 2.5 0 0 1-5 0z" fill="#e3a008"/><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.6.5.8 1.1.8 1.7V17h6v-1c0-.6.3-1.2.8-1.7A6.5 6.5 0 0 0 12 2.5z" fill="#fbbf24"/></svg>';
const chat = $('#chat');
function addUser(t) {
  chat.insertAdjacentHTML('beforeend', `<div class="msg user">${USER_AV}<div class="bubble">${esc(t)}</div></div>`);
  chat.scrollTop = chat.scrollHeight;
}
function addBot(html, tip) {
  chat.insertAdjacentHTML(
    'beforeend',
    `<div class="msg bot">${BOT_AV}<div class="bubble">${html}</div></div>` +
      (tip ? `<div class="tip"><h3>${TIP_IC}Recomendação</h3><p>${tip}</p></div>` : '')
  );
  chat.scrollTop = chat.scrollHeight;
}
const list = items =>
  `<ol class="findings">${items.map((t, i) => `<li><span class="n">${i + 1}</span><span>${t}</span></li>`).join('')}</ol>`;
const KB = {
  checkout: {
    h: 'Encontrei 12 execuções com falha na pipeline de <b>Checkout</b>, com 3 padrões principais:',
    l: [
      'Timeout em chamadas da API de pagamento (6 ocorrências – 50%)',
      'Resposta HTTP 500 no fluxo de confirmação (4 ocorrências – 33%)',
      'Validação de carrinho com dados inválidos (2 ocorrências – 17%)',
    ],
    tip: 'Verifique a estabilidade do serviço de pagamento e analise os logs das execuções entre 10h e 12h, quando houve maior concentração de falhas.',
  },
  pagamento: {
    h: 'A pipeline de <b>Pagamento</b> teve 7 execuções com falha, com 2 padrões principais:',
    l: [
      'Estorno parcial retornando valor divergente (4 ocorrências – 57%)',
      'Webhook do gateway chegando após o timeout do teste (3 ocorrências – 43%)',
    ],
    tip: 'Aumente o tempo de espera do webhook para 45s no ambiente de homologação e revise a regra de arredondamento do estorno parcial.',
  },
  cadastro: {
    h: 'A pipeline de <b>Cadastro</b> teve 5 execuções com falha:',
    l: [
      'Validação de CPF duplicado intermitente (3 ocorrências – 60%)',
      'E-mail de boas-vindas não recebido no tempo esperado (2 ocorrências – 40%)',
    ],
    tip: 'Isole a massa de dados de CPF por execução para evitar colisão entre testes paralelos.',
  },
  busca: {
    h: 'A pipeline de <b>Busca</b> está estável, com 98,1% de sucesso. As poucas falhas foram:',
    l: [
      'Índice de busca desatualizado logo após o deploy (2 ocorrências)',
      'Ordenação por preço com itens empatados (1 ocorrência)',
    ],
    tip: 'Adicione uma espera pela reindexação após o deploy antes de iniciar os cenários de busca.',
  },
  autentica: {
    h: 'A pipeline de <b>Autenticação</b> tem 99,0% de sucesso. Única falha recorrente:',
    l: ['Sessão expirando durante a recuperação de senha (1 ocorrência)'],
    tip: 'Aumente a validade do token de recuperação no ambiente de teste.',
  },
  outros: {
    h: 'As pipelines agrupadas em <b>Outros</b> somam 18% das falhas:',
    l: ['Sessão expirando no fluxo de Autenticação (5 ocorrências)', 'Índice desatualizado na Busca (3 ocorrências)'],
    tip: 'Revise os tempos de espera após deploy antes de iniciar as suítes.',
  },
};
function answer(q) {
  const t = q.toLowerCase(),
    P = PERIODS[period];
  if (/agora|tempo real|rodando|em andamento|ao vivo/.test(t)) {
    const run = LIVE.filter(r => r.s === 'Executando');
    if (!run.length) return ['Nenhuma esteira está em execução neste momento.', null];
    return [
      `Há <b>${run.length}</b> esteira${run.length === 1 ? '' : 's'} em execução agora:` +
        list(
          run.map(r => {
            const sc = r.live.sc,
              d = sc.filter(c => c.st === 'pass' || c.st === 'fail').length,
              f = sc.filter(c => c.st === 'fail').length;
            return `${esc(r.p)} (#${r.id}) – ${d}/${r.t} cenários, ${f} falha${f === 1 ? '' : 's'}, ${fmtDur(Math.round(r.live.el))} decorridos`;
          })
        ),
      run.some(r => r.live.sc.some(c => c.st === 'fail'))
        ? 'Há falhas em andamento. Acompanhe em Execuções › Ao vivo e, se o timeout de pagamento se repetir, interrompa a esteira para liberar a fila.'
        : null,
    ];
  }
  const m = t.match(/#?(\d{5})/);
  if (m) {
    const r = RUNS.find(x => x.id === +m[1]);
    if (r) {
      const f = suiteFor(r).filter(x => x.f);
      if (!f.length) return [`A execução <b>#${r.id}</b> de ${esc(r.p)} passou em todos os ${r.t} cenários.`, null];
      return [
        `A execução <b>#${r.id}</b> de <b>${esc(r.p)}</b> falhou em ${f.length} de ${r.t} cenários:` +
          list(
            f.map(
              x =>
                `${esc(x.n)}${/Timeout/.test(x.n) ? ' — sem resposta da API de pagamento em 30s' : /Confirmar/.test(x.n) ? ' — HTTP 500 em /checkout/confirm' : ' — status 422 inesperado'}`
            )
          ),
        'A causa provável é instabilidade no serviço de pagamento. Verifique os logs do gateway no horário da execução e considere aumentar o timeout da chamada para 45s.',
      ];
    }
  }
  for (const k of Object.keys(KB))
    if (t.includes(k)) {
      const a = KB[k];
      return [a.h + list(a.l), a.tip];
    }
  if (/dura|lent|tempo/.test(t)) {
    const s = [...PIPES].sort((a, b) => b.dur - a.dur).slice(0, 3);
    return [
      'As pipelines mais lentas são:' +
        list(s.map(p => `${esc(p.name)} – ${fmtDur(p.dur)} em média`)) +
        `<p style="margin:12px 0 0">A duração média geral está em <b>${P.dur}</b> (${P.durD} vs. período anterior).</p>`,
      'Paralelize os cenários de pagamento do Checkout para economizar cerca de 2 minutos por execução.',
    ];
  }
  if (/instáve|instave|flaky|intermit/.test(t))
    return [
      `Sim. Identifiquei <b>${metrics(runsIn(30)).flaky.length} testes instáveis</b> nos últimos 30 dias. Os mais críticos:` +
        list([
          'CT-004 Timeout na API de pagamento – 12,0% de falha',
          'CT-011 Confirmar pedido – 8,0% de falha',
          'CT-003 Pagamento com cartão inválido – 6,1% de falha',
        ]),
      'Coloque esses cenários em quarentena até a correção, para que não bloqueiem o deploy, e acompanhe a taxa na aba Flaky Tests.',
    ];
  if (/resum|release|geral|semana|como est|status|taxa|qualidade/.test(t))
    return [
      `Nesta semana foram <b>${P.exec}</b> execuções, com <b>${P.rate}%</b> de sucesso e <b>${P.fail}</b> falhas.` +
        list([
          'Taxa de sucesso subiu para 95,5% no último dia',
          `Duração média ${P.durD} vs. período anterior`,
          `Checkout concentra ${P.split[0]}% das falhas`,
        ]),
      'A release pode seguir se os timeouts de pagamento do Checkout forem resolvidos: eles respondem por metade das falhas.',
    ];
  if (/falh|erro|quebr|por que/.test(t)) {
    const a = KB.checkout;
    return [a.h + list(a.l), a.tip];
  }
  return [
    'Posso analisar falhas por pipeline, uma execução específica (ex.: #10432), duração, testes instáveis ou resumir a release. Experimente:<div class="suggest" style="margin-top:12px"><button data-suggest="Resuma a qualidade da release desta semana.">Resumo da release</button><button data-suggest="Existe algum teste instável (flaky)?">Testes instáveis</button><button data-suggest="Por que a execução #10432 falhou?">Execução #10432</button></div>',
    null,
  ];
}
function askAgent(q) {
  q = q.trim();
  if (!q) return;
  addUser(q);
  chat.insertAdjacentHTML(
    'beforeend',
    `<div class="msg bot" id="typing">${BOT_AV}<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`
  );
  chat.scrollTop = chat.scrollHeight;
  setTimeout(() => {
    $('#typing')?.remove();
    const [h, tip] = answer(q);
    addBot(h, tip);
  }, 900);
}
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#ask').value;
  $('#ask').value = '';
  askAgent(v);
});
$('#infoBtn').addEventListener('click', () =>
  addBot(
    `Sou o agente de QA. Analiso execuções, agrupo falhas por padrão e sugiro próximos passos. Modelo configurado: <b>${esc(CFG.prov)} · ${esc(CFG.model)}</b>. Nesta versão MVP as respostas usam dados de exemplo.`
  )
);
