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
): Avaliacao {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));

  if (pedido.forma === "a_vista") {
    const melhor = propostaAVista(divida, politica, hoje, faixa.descontoMaximoPct);
    if (pedido.totalDesejadoCents !== undefined && pedido.totalDesejadoCents < melhor.totalCents) {
      return {
        aceitavel: false,
        motivo: "valor_abaixo_do_permitido",
        detalhe: "o valor pedido fica abaixo do mínimo autorizado para pagamento à vista",
        contraproposta: melhor,
      };
    }
    if (pedido.descontoPct !== undefined && pedido.descontoPct > faixa.descontoMaximoPct) {
      return {
        aceitavel: false,
        motivo: "desconto_acima_do_maximo",
        detalhe: `o desconto máximo autorizado é de ${faixa.descontoMaximoPct}%`,
        contraproposta: melhor,
      };
    }
    const pct =
      pedido.totalDesejadoCents !== undefined
        ? // floor: o total resultante nunca fica ABAIXO do que o devedor ofereceu.
          Math.max(0, Math.floor(((divida.saldoCents - pedido.totalDesejadoCents) / divida.saldoCents) * 100))
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

/**
 * A escada de ofertas, na ordem em que a Bella deve apresentá-las: à vista com
 * o desconto inicial, à vista com o desconto máximo, e o parcelamento mais leve.
 * Degraus repetidos (faixa sem desconto) são removidos.
 */
export function escadaDeOfertas(
  divida: Divida,
  politica: PoliticaDeNegociacao,
  hoje: Date,
): Proposta[] {
  const faixa = faixaVigente(politica, diasDeAtraso(divida, hoje));
  const degraus = [
    propostaAVista(divida, politica, hoje, faixa.descontoInicialPct),
    propostaAVista(divida, politica, hoje, faixa.descontoMaximoPct),
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
