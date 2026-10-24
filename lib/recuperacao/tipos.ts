/**
 * Domínio de RECUPERAÇÃO DE CRÉDITO (cobrança de dívidas) — Pacare / agente Bella.
 *
 * Não confundir com `lib/cobranca/`, que é a cobrança da ASSINATURA do próprio
 * sistema (Asaas/Stripe). Aqui a cobrança é a do credor contra o devedor.
 *
 * Todo valor em CENTAVOS (inteiro), como no resto do repo. Percentuais em
 * pontos percentuais (5 = 5%).
 */

/** Uma dívida em aberto de um devedor, como o agente a enxerga. */
export interface Divida {
  id: string;
  /** Nome do credor que aparece para o devedor ("Banco Nova Era"). */
  credor: string;
  /** Produto de origem ("cartão de crédito", "empréstimo pessoal"...). */
  produto: string;
  /** Saldo atualizado, já com encargos, em centavos. */
  saldoCents: number;
  /** Data do vencimento mais antigo em aberto (ISO yyyy-mm-dd). */
  vencimentoOriginal: string;
  /** Parcelas vencidas que compõem o saldo (informativo). */
  parcelasVencidas?: number;
}

/**
 * Faixa de desconto à vista por atraso. A faixa vale a partir de `diasMinimos`
 * de atraso; a de maior `diasMinimos` que couber é a que vale.
 */
export interface FaixaDeDesconto {
  diasMinimos: number;
  /** Desconto que o agente oferece primeiro. */
  descontoInicialPct: number;
  /** Teto absoluto: o agente nunca passa disso. */
  descontoMaximoPct: number;
}

/** O que o credor autoriza o agente a negociar. */
export interface PoliticaDeNegociacao {
  faixas: FaixaDeDesconto[];
  /** Número máximo de parcelas, contando a entrada como a 1ª. */
  maxParcelas: number;
  /** Entrada mínima, em % do saldo, quando parcelado. */
  entradaMinimaPct: number;
  /** Nenhuma parcela (nem a entrada) pode ser menor que isto. */
  parcelaMinimaCents: number;
  /** Prazo para pagar a 1ª parcela / à vista, em dias corridos. */
  prazoPrimeiroPagamentoDias: number;
  /** Parcelado tem desconto? Por padrão, não (como a Mia: só à vista tem desconto). */
  descontoNoParceladoPct: number;
  /**
   * De quanto em quanto o desconto à vista sobe numa negociação, em pontos
   * percentuais (0,5 = de 5% para 5,5%). Entre o inicial e o máximo da faixa,
   * a agente só sobe um passo por vez, e só depois de uma objeção.
   */
  passoDescontoPct: number;
}

export type FormaDePagamento = "a_vista" | "parcelado";

export interface Proposta {
  forma: FormaDePagamento;
  /** Total que o devedor vai pagar, em centavos. */
  totalCents: number;
  descontoPct: number;
  descontoCents: number;
  /** 1 para à vista. */
  parcelas: number;
  /** Valor da entrada (= 1ª parcela). À vista: o próprio total. */
  entradaCents: number;
  /** Valor de cada parcela depois da entrada (0 à vista). */
  parcelaCents: number;
  /** Vencimento da 1ª parcela / do à vista (ISO yyyy-mm-dd). */
  primeiroVencimento: string;
}

/**
 * As tabulações de desfecho de uma conversa de cobrança — as mesmas sete que a
 * Monest exibe (ia.monest.com.br), mais `opt_out` e `numero_errado`, que a Mia
 * mistura em "cobrança indisponível" e nós queremos medir separado.
 */
export const DESFECHOS = [
  "identidade_confirmada",
  "acordo_realizado",
  "acordo_nao_realizado",
  "contra_proposta",
  "retornar_contato",
  "recusa_de_informacao",
  "cobranca_indisponivel",
  "numero_errado",
  "opt_out",
] as const;
export type Desfecho = (typeof DESFECHOS)[number];

export const ROTULO_DO_DESFECHO: Record<Desfecho, string> = {
  identidade_confirmada: "Identidade confirmada",
  acordo_realizado: "Acordo realizado",
  acordo_nao_realizado: "Acordo não realizado",
  contra_proposta: "Contra proposta",
  retornar_contato: "Retornar contato",
  recusa_de_informacao: "Recusa de informação",
  cobranca_indisponivel: "Cobrança indisponível",
  numero_errado: "Número errado",
  opt_out: "Pediu para não receber mais mensagens",
};
