/**
 * O guardrail de COBRANÇA — conferência determinística da mensagem que a Bella
 * vai mandar, antes de sair (gate `cobranca` em `before-send.ts`).
 *
 * Cinco regras, na ordem em que são conferidas:
 *  1. opt-out: quem pediu para não receber não recebe mensagem ATIVA (responder
 *     quando a pessoa escreve continua permitido — a Mia ignorava o pedido);
 *  2. horário: mensagem ativa só dentro da janela da carteira;
 *  3. CDC art. 42: nada de ameaça, constrangimento ou exposição do devedor;
 *  4. nenhum valor antes da identidade confirmada (LGPD: dívida é dado pessoal);
 *  5. desconto e parcelas dentro do teto da política.
 *
 * Puro e síncrono, como os demais gates. Quem carrega o estado do banco é o
 * `before-send`; sem dívida para o contato, o estado é nulo e o gate não arma.
 */

export interface EstadoDaCobrancaNoEnvio {
  identidadeConfirmada: boolean;
  optOut: boolean;
  /** Esta tentativa responde a uma mensagem recebida? Omitido = mensagem ativa. */
  resposta?: boolean;
  janela: { horaInicio: number; horaFim: number; dias: readonly number[]; fuso: string };
  /** Maior desconto que a política permite hoje, em pontos percentuais. */
  descontoMaximoPct: number;
  maxParcelas: number;
  /** A pessoa deu sinal de risco à vida: nada de cobrança até um humano liberar. */
  cuidado?: boolean;
}

export type VetoDeCobranca = {
  code:
    | "cobranca_opt_out"
    | "cobranca_fora_do_horario"
    | "cobranca_linguagem_abusiva"
    | "cobranca_valor_antes_da_identidade"
    | "cobranca_acima_da_politica"
    | "cobranca_pausada_por_cuidado";
  reason: string;
};

// Assunto de cobrança (para a pausa por cuidado): proposta, acordo, pagamento.
const COBRANCA = /\b(acordo|desconto|parcela|parcelad|[àa] vista|pix|boleto|negocia|proposta)/i;

// Valor em dinheiro: "R$ 1.234,56", "R$300", "3.769,76", "200 reais".
const DINHEIRO = /R\$\s*\d|\b\d{1,3}(?:\.\d{3})*,\d{2}\b|\b\d+(?:[.,]\d+)?\s*reais\b/i;

/**
 * CDC art. 42: "o consumidor inadimplente não será exposto a ridículo, nem
 * submetido a qualquer tipo de constrangimento ou ameaça". Os padrões abaixo
 * são as ameaças e exposições clássicas de cobrança abusiva.
 */
const ABUSIVA: ReadonlyArray<RegExp> = [
  /\b(pol[ií]cia|delegacia|pris[aã]o|cadeia|preso|presa)\b/i,
  // "processar o pagamento" é normal; a ameaça é processar A PESSOA.
  /\b(te|lhe)\s+processar\b|\bprocessar\s+(voc[eê]|o senhor|a senhora)\b|\b(ser[aá]|vai ser)\s+processad[oa]\b/i,
  /\b(processo criminal|crime|criminos[oa]|caloteir[oa]|vagabund[oa]|safad[oa])\b/i,
  /\b(sua|seu|seus|suas)\s+(fam[ií]lia|chefe|patr[aã]o|vizinh[oa]s?|parentes|colegas)\b.{0,40}\b(sab(er|endo|e)|avisad|informad|contat|ligar|ligaremos|procurar)/i,
  /\b(avisar|contatar|ligar para|informar)\s+(a\s+|o\s+|os\s+|as\s+)?(sua|seu|seus|suas)\s+(fam[ií]lia|chefe|patr[aã]o|vizinh[oa]s?|parentes|colegas)\b/i,
  /\b(vergonha|humilha|expor voc[eê]|exposto|exposta|vai se arrepender|[uú]ltimo aviso antes)\b/i,
  /\b(penhor(a|ar)|tomar (seus|os seus) bens|bloquear (seu|o seu) sal[aá]rio)\b/i,
];

function horaEDiaLocais(agora: Date, fuso: string): { hora: number; dia: number } {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(agora);
  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? 0);
  const nome = partes.find((p) => p.type === "weekday")?.value ?? "Sun";
  const dia = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nome);
  return { hora, dia };
}

function maiorPercentual(texto: string): number | null {
  let maior: number | null = null;
  for (const m of texto.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s*%/g)) {
    const v = Number(m[1]!.replace(",", "."));
    if (maior === null || v > maior) maior = v;
  }
  return maior;
}

const NEGA_ANTES = /\bn[aã]o\s+(?:consigo|consegui|d[aá]|deu|tem como|posso|foi poss[ií]vel|[eé] poss[ií]vel|sai)\b[^.!?\n]{0,25}$/i;
const NEGA_DEPOIS = /^[^.!?\n]{0,8}\bn[aã]o\s+(?:d[aá]|deu|consigo|foi liberad|[eé] poss[ií]vel)/i;

function maiorParcelamento(texto: string): number | null {
  let maior: number | null = null;
  for (const m of texto.matchAll(/\b(\d{1,3})\s*(?:x\b|vezes\b|parcelas\b)/gi)) {
    // "não consegui em 24 vezes" / "24 vezes não dá" é recusa do pedido, não oferta.
    const antes = texto.slice(Math.max(0, m.index - 40), m.index);
    const depois = texto.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (NEGA_ANTES.test(antes) || NEGA_DEPOIS.test(depois)) continue;
    const v = Number(m[1]);
    if (maior === null || v > maior) maior = v;
  }
  return maior;
}

export function avaliarEnvioDeCobranca(
  corpo: string,
  estado: EstadoDaCobrancaNoEnvio,
  agora: Date,
): VetoDeCobranca | null {
  const ativa = estado.resposta !== true;

  if (ativa && estado.optOut) {
    return {
      code: "cobranca_opt_out",
      reason:
        "esta pessoa pediu para não receber mais mensagens de cobrança — não inicie conversa; " +
        "só responda se ela escrever primeiro.",
    };
  }

  if (ativa) {
    const { hora, dia } = horaEDiaLocais(agora, estado.janela.fuso);
    const dentro =
      estado.janela.dias.includes(dia) && hora >= estado.janela.horaInicio && hora < estado.janela.horaFim;
    if (!dentro) {
      return {
        code: "cobranca_fora_do_horario",
        reason:
          `fora do horário permitido para cobrança (${estado.janela.horaInicio}h às ${estado.janela.horaFim}h) — ` +
          "agende o contato para o próximo horário permitido em vez de enviar agora.",
      };
    }
  }

  // Sinal de risco à vida: a conversa continua (acolher, passar ajuda), a cobrança não.
  if (estado.cuidado && (ativa || DINHEIRO.test(corpo) || COBRANCA.test(corpo))) {
    return {
      code: "cobranca_pausada_por_cuidado",
      reason: ativa
        ? "a cobrança desta pessoa está pausada por um sinal de risco à vida — não inicie conversa; um humano retoma."
        : "a cobrança desta pessoa está pausada por um sinal de risco à vida — não fale de valor, acordo, " +
          "pagamento ou retorno. Acolha, reforce os contatos de ajuda e diga que um atendente vai continuar.",
    };
  }

  if (ABUSIVA.some((r) => r.test(corpo))) {
    return {
      code: "cobranca_linguagem_abusiva",
      reason:
        "a mensagem tem ameaça, constrangimento ou exposição do devedor (proibido pelo CDC, art. 42) — " +
        "reescreva com respeito: informe a pendência e ofereça a negociação, sem pressão.",
    };
  }

  if (!estado.identidadeConfirmada && DINHEIRO.test(corpo)) {
    return {
      code: "cobranca_valor_antes_da_identidade",
      reason:
        "a mensagem fala de valor antes de a identidade ser confirmada — peça primeiro os 3 primeiros " +
        "dígitos do CPF e confirme com cobranca_verificar_identidade.",
    };
  }

  const pct = maiorPercentual(corpo);
  if (pct !== null && pct > estado.descontoMaximoPct) {
    return {
      code: "cobranca_acima_da_politica",
      reason:
        `a mensagem oferece ${pct}% e o teto autorizado pelo credor é ${estado.descontoMaximoPct}% — ` +
        "use só os valores devolvidos por cobranca_consultar_divida ou cobranca_simular_acordo.",
    };
  }
  const parcelas = maiorParcelamento(corpo);
  if (parcelas !== null && parcelas > estado.maxParcelas) {
    return {
      code: "cobranca_acima_da_politica",
      reason:
        `a mensagem oferece ${parcelas} parcelas e o máximo autorizado é ${estado.maxParcelas} — ` +
        "use só os valores devolvidos por cobranca_simular_acordo.",
    };
  }

  return null;
}
