/**
 * Regras PURAS de negociação: o que o agente pode oferecer, dado o saldo, o
 * atraso e a política do credor. Sem banco, sem relógio implícito (o "hoje"
 * entra como argumento) — é isto que as ferramentas da Bella chamam e o que o
 * guardrail usa para saber o teto.
 *
 * O modelo NUNCA calcula valor sozinho: ele pede uma simulação e repete o que
 * voltou. Conta de cabeça de LLM é a origem número um de acordo errado.
 */
import type {
  Divida,
  FaixaDeDesconto,
  FormaDePagamento,
  PoliticaDeNegociacao,
  Proposta,
} from "./tipos";

/** Política conservadora, igual à observada na Mia (5% à vista, até 12x). */
export const POLITICA_PADRAO: PoliticaDeNegociacao = {
  faixas: [
    { diasMinimos: 0, descontoInicialPct: 0, descontoMaximoPct: 0 },
    { diasMinimos: 30, descontoInicialPct: 3, descontoMaximoPct: 5 },
    { diasMinimos: 180, descontoInicialPct: 5, descontoMaximoPct: 10 },
    { diasMinimos: 360, descontoInicialPct: 10, descontoMaximoPct: 20 },
  ],
  maxParcelas: 12,
  entradaMinimaPct: 5,
  parcelaMinimaCents: 5000,
  prazoPrimeiroPagamentoDias: 6,
  descontoNoParceladoPct: 0,
  passoDescontoPct: 0.5,
};

const MS_POR_DIA = 86_400_000;

function paraDataUTC(iso: string): Date {
  const [a, m, d] = iso.split("-").map(Number);
  if (!a || !m || !d) throw new Error(`data_invalida: ${iso}`);
  return new Date(Date.UTC(a, m - 1, d));
}

function paraISO(data: Date): string {
  return data.toISOString().slice(0, 10);
}

/** Dia (yyyy-mm-dd) de `hoje` no calendário UTC — quem chama passa a data local se precisar. */
export function diaDe(hoje: Date): string {
  return paraISO(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())));
}

export function somarDias(iso: string, dias: number): string {
  return paraISO(new Date(paraDataUTC(iso).getTime() + dias * MS_POR_DIA));
}

export function diasDeAtraso(divida: Divida, hoje: Date): number {
  const diff = paraDataUTC(diaDe(hoje)).getTime() - paraDataUTC(divida.vencimentoOriginal).getTime();
  return Math.max(0, Math.floor(diff / MS_POR_DIA));
}

export function faixaVigente(politica: PoliticaDeNegociacao, dias: number): FaixaDeDesconto {
  const ordenadas = [...politica.faixas].sort((a, b) => a.diasMinimos - b.diasMinimos);
  let vigente: FaixaDeDesconto = { diasMinimos: 0, descontoInicialPct: 0, descontoMaximoPct: 0 };
  for (const f of ordenadas) if (dias >= f.diasMinimos) vigente = f;
  return vigente;
}

function aplicarDesconto(saldoCents: number, pct: number): { total: number; desconto: number } {
  const desconto = Math.round((saldoCents * pct) / 100);
  return { total: saldoCents - desconto, desconto };
}

/**
 * Oferta à vista. Sem `descontoPct`, usa o desconto INICIAL da faixa; com ele,
 * respeita o teto da faixa (nunca passa do máximo).
 */
export function propostaAVista(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
  descontoPct?: number,
): Proposta {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));
  const pct = Math.min(descontoPct ?? faixa.descontoInicialPct, faixa.descontoMaximoPct);
  const { total, desconto } = aplicarDesconto(divida.saldoCents, Math.max(0, pct));
  return {
    forma: "a_vista",
    totalCents: total,
    descontoPct: Math.max(0, pct),
    descontoCents: desconto,
    parcelas: 1,
    entradaCents: total,
    parcelaCents: 0,
    primeiroVencimento: somarDias(diaDe(hoje), politica.prazoPrimeiroPagamentoDias),
  };
}

export type ResultadoParcelado =
  | { ok: true; proposta: Proposta }
  | { ok: false; motivo: MotivoDeRecusa; detalhe: string };

export type MotivoDeRecusa =
  | "parcelas_acima_do_maximo"
  | "parcelas_invalidas"
  | "entrada_abaixo_do_minimo"
  | "entrada_acima_do_total"
  | "parcela_abaixo_do_minimo"
  | "desconto_acima_do_maximo"
  | "desconto_nao_liberado"
  | "valor_abaixo_do_permitido";

/**
 * Parcelamento com entrada. A entrada é a 1ª parcela; o resto se divide em
 * parcelas iguais e o centavo que sobra vai para a entrada (como a Mia faz:
 * entrada R$ 200,04 + 11× R$ 324,52).
 */
export function propostaParcelada(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
  pedido: { parcelas: number; entradaCents?: number },
): ResultadoParcelado {
  const n = Math.trunc(pedido.parcelas);
  if (!Number.isFinite(n) || n < 2) {
    return { ok: false, motivo: "parcelas_invalidas", detalhe: "parcelado precisa de pelo menos 2 parcelas" };
  }
  if (n > politica.maxParcelas) {
    return {
      ok: false,
      motivo: "parcelas_acima_do_maximo",
      detalhe: `o máximo autorizado é ${politica.maxParcelas} parcelas, contando a entrada`,
    };
  }
  const { total, desconto } = aplicarDesconto(divida.saldoCents, politica.descontoNoParceladoPct);
  const entradaMinima = Math.max(
    Math.ceil((total * politica.entradaMinimaPct) / 100),
    politica.parcelaMinimaCents,
  );
  const entradaPedida = pedido.entradaCents ?? entradaMinima;
  if (entradaPedida < entradaMinima) {
    return {
      ok: false,
      motivo: "entrada_abaixo_do_minimo",
      detalhe: `a entrada mínima é de ${entradaMinima} centavos`,
    };
  }
  if (entradaPedida >= total) {
    return { ok: false, motivo: "entrada_acima_do_total", detalhe: "com essa entrada, é pagamento à vista" };
  }
  const parcela = Math.floor((total - entradaPedida) / (n - 1));
  if (parcela < politica.parcelaMinimaCents) {
    return {
      ok: false,
      motivo: "parcela_abaixo_do_minimo",
      detalhe: `cada parcela precisa ser de pelo menos ${politica.parcelaMinimaCents} centavos`,
    };
  }
  const entrada = total - parcela * (n - 1);
  return {
    ok: true,
    proposta: {
      forma: "parcelado",
      totalCents: total,
      descontoPct: politica.descontoNoParceladoPct,
      descontoCents: desconto,
      parcelas: n,
      entradaCents: entrada,
      parcelaCents: parcela,
      primeiroVencimento: somarDias(diaDe(hoje), politica.prazoPrimeiroPagamentoDias),
    },
  };
}

/** O que o devedor pediu, do jeito que o modelo consegue extrair da conversa. */
export interface PedidoDoDevedor {
  forma: FormaDePagamento;
  descontoPct?: number;
  parcelas?: number;
  entradaCents?: number;
  /** "Consigo pagar R$ 100 por mês." */
  valorParcelaDesejadoCents?: number;
  /** "Pago R$ 1.000 e quito." */
  totalDesejadoCents?: number;
}

export type Avaliacao =
  | { aceitavel: true; proposta: Proposta }
  | {
      aceitavel: false;
      motivo: MotivoDeRecusa;
      detalhe: string;
      /** A melhor proposta DENTRO da política que chega mais perto do pedido. */
      contraproposta: Proposta;
    };

/**
 * Avalia o pedido do devedor contra a política e, se não couber, devolve a
 * contraproposta mais próxima possível — é o que transforma "não posso" em
 * próxima oferta, em vez de um beco sem saída.
 */
export function avaliarPedido(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
  pedido: PedidoDoDevedor,
  /**
   * O desconto à vista já liberado NESTA negociação (veja `proximoDegrauAVista`);
   * `null` = nada liberado ainda (vale o inicial da faixa). Omitido = o teto da
   * faixa — quem negocia com a pessoa sempre passa o liberado, para a
   * contraproposta nunca entregar o máximo de uma vez.
   */
  liberadoPct?: number | null,
): Avaliacao {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));

  if (pedido.forma === "a_vista") {
    const teto = liberadoPct === undefined ? faixa.descontoMaximoPct : descontoLiberado(faixa, liberadoPct);
    const melhor = propostaAVista(divida, politica, hoje, teto);
    if (pedido.totalDesejadoCents !== undefined && pedido.totalDesejadoCents < melhor.totalCents) {
      return {
        aceitavel: false,
        motivo: "valor_abaixo_do_permitido",
        detalhe:
          teto < faixa.descontoMaximoPct
            ? "o valor pedido fica abaixo da condição liberada até agora"
            : "o valor pedido fica abaixo do mínimo autorizado para pagamento à vista",
        contraproposta: melhor,
      };
    }
    if (pedido.descontoPct !== undefined && pedido.descontoPct > teto) {
      return teto < faixa.descontoMaximoPct
        ? {
            aceitavel: false,
            motivo: "desconto_nao_liberado",
            detalhe: `a condição liberada até agora é de ${pctBR(teto)} de desconto`,
            contraproposta: melhor,
          }
        : {
            aceitavel: false,
            motivo: "desconto_acima_do_maximo",
            detalhe: `o desconto máximo autorizado é de ${pctBR(teto)}`,
            contraproposta: melhor,
          };
    }
    const pct =
      pedido.totalDesejadoCents !== undefined
        ? // floor: o total resultante nunca fica ABAIXO do que o devedor ofereceu.
          // Em centésimos de ponto: com passo de 0,5, "pago o valor de 5,5%" não pode virar 5%.
          Math.max(0, Math.floor(((divida.saldoCents - pedido.totalDesejadoCents) / divida.saldoCents) * 10_000) / 100)
        : pedido.descontoPct;
    return { aceitavel: true, proposta: propostaAVista(divida, politica, hoje, pct) };
  }

  // Parcelado: o pedido pode vir por número de parcelas ou por quanto cabe no mês.
  let parcelas = pedido.parcelas;
  if (parcelas === undefined && pedido.valorParcelaDesejadoCents !== undefined) {
    const entrada = pedido.entradaCents ?? 0;
    const restante = divida.saldoCents - entrada;
    parcelas = 1 + Math.ceil(restante / Math.max(1, pedido.valorParcelaDesejadoCents));
  }
  const r = propostaParcelada(divida, politica, hoje, {
    parcelas: parcelas ?? politica.maxParcelas,
    entradaCents: pedido.entradaCents,
  });
  if (r.ok) return { aceitavel: true, proposta: r.proposta };

  return {
    aceitavel: false,
    motivo: r.motivo,
    detalhe: r.detalhe,
    contraproposta: melhorParceladoPossivel(divida, politica, hoje),
  };
}

/** O parcelamento mais leve que a política permite: máximo de parcelas, entrada mínima. */
export function melhorParceladoPossivel(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
): Proposta {
  for (let n = politica.maxParcelas; n >= 2; n--) {
    const r = propostaParcelada(divida, politica, hoje, { parcelas: n });
    if (r.ok) return r.proposta;
  }
  // Saldo pequeno demais para parcelar: só sobra o à vista.
  return propostaAVista(divida, politica, hoje);
}

/** "5,5%" — percentual como se escreve no Brasil. */
export function pctBR(pct: number): string {
  return `${String(Math.round(pct * 100) / 100).replace(".", ",")}%`;
}

/** O desconto à vista em vigor: o liberado na negociação, preso entre o inicial e o teto da faixa. */
export function descontoLiberado(faixa: FaixaDeDesconto, liberadoPct: number | null | undefined): number {
  const base = liberadoPct ?? faixa.descontoInicialPct;
  return Math.min(faixa.descontoMaximoPct, Math.max(faixa.descontoInicialPct, base));
}

export type Degrau =
  | { esgotado: false; descontoPct: number; proposta: Proposta; alcancaOProposto: boolean | null }
  | { esgotado: true; descontoPct: number };

/**
 * O PRÓXIMO degrau do desconto à vista — e só ele. É assim que a negociação
 * sobe de pouco em pouco (5% → 5,5% → 6%...) em vez de saltar do inicial para
 * o teto: quem chama nunca enxerga o máximo, só o passo seguinte.
 *
 * Com `totalPropostoCents` ("pago R$ 3.400"), o degrau para no MENOR desconto
 * que chega nesse valor, se ele couber no passo; senão, sobe um passo só e
 * diz que ainda não alcança.
 */
export function proximoDegrauAVista(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
  liberadoPct: number | null | undefined,
  totalPropostoCents?: number,
): Degrau {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));
  const atual = descontoLiberado(faixa, liberadoPct);
  const passo = politica.passoDescontoPct > 0 ? politica.passoDescontoPct : 0.5;
  if (atual >= faixa.descontoMaximoPct) return { esgotado: true, descontoPct: atual };

  let pct = Math.min(faixa.descontoMaximoPct, arredondarPct(atual + passo));
  let alcancaOProposto: boolean | null = null;
  if (totalPropostoCents !== undefined) {
    // Menor desconto (na grade do passo) cujo total fica dentro do que a pessoa propôs.
    const necessario = ((divida.saldoCents - totalPropostoCents) / divida.saldoCents) * 100;
    const naGrade = arredondarPct(Math.ceil(necessario / passo - 1e-9) * passo);
    if (naGrade <= atual) {
      pct = atual;
      alcancaOProposto = true;
    } else if (naGrade <= pct) {
      pct = naGrade;
      alcancaOProposto = true;
    } else {
      alcancaOProposto = false;
    }
  }
  return { esgotado: false, descontoPct: pct, proposta: propostaAVista(divida, politica, hoje, pct), alcancaOProposto };
}

function arredondarPct(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * As ofertas de abertura, na ordem em que a Bella deve apresentá-las: à vista
 * com o desconto liberado (de início, o inicial da faixa) e o parcelamento mais
 * leve. O teto da faixa NÃO entra: desconto maior só sai, passo a passo, de
 * `proximoDegrauAVista`. Degraus repetidos são removidos.
 */
export function escadaDeOfertas(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
  liberadoPct?: number | null,
): Proposta[] {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));
  const degraus = [
    propostaAVista(divida, politica, hoje, descontoLiberado(faixa, liberadoPct)),
    melhorParceladoPossivel(divida, politica, hoje),
  ];
  const vistos = new Set<string>();
  return degraus.filter((p) => {
    const chave = `${p.forma}:${p.totalCents}:${p.parcelas}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

/** Confere uma proposta já montada contra a política (defesa em profundidade no registro do acordo). */
export function propostaRespeitaPolitica(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
  proposta: Proposta,
): { ok: true } | { ok: false; motivo: MotivoDeRecusa } {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));
  if (proposta.forma === "a_vista") {
    const piso = propostaAVista(divida, politica, hoje, faixa.descontoMaximoPct).totalCents;
    return proposta.totalCents >= piso ? { ok: true } : { ok: false, motivo: "desconto_acima_do_maximo" };
  }
  if (proposta.parcelas > politica.maxParcelas) return { ok: false, motivo: "parcelas_acima_do_maximo" };
  const r = propostaParcelada(divida, politica, hoje, {
    parcelas: proposta.parcelas,
    entradaCents: proposta.entradaCents,
  });
  if (!r.ok) return { ok: false, motivo: r.motivo };
  return r.proposta.totalCents === proposta.totalCents ? { ok: true } : { ok: false, motivo: "valor_abaixo_do_permitido" };
}
