/**
 * Provedor de pagamento da recuperação — TROCÁVEL.
 *
 * Na validação roda o `ProvedorFake` (PIX e boleto de mentira, marcados como
 * TESTE em todo lugar). Em produção entra o Pixxifeito, implementando a MESMA
 * interface; nada acima desta pasta muda.
 */

export interface PedidoDeCobranca {
  acordoId: string;
  /** Número da parcela (1 = entrada ou à vista). */
  parcela: number;
  valorCents: number;
  vencimento: string;
  devedorNome: string;
  /** Descrição curta que aparece no PIX/boleto. */
  descricao: string;
}

export interface CobrancaGerada {
  provedor: string;
  /** Identificador da cobrança no provedor. */
  idExterno: string;
  /** true no fake: a mensagem ao devedor PRECISA avisar que é teste. */
  teste: boolean;
  pix?: { copiaECola: string; txid: string };
  boleto?: { linhaDigitavel: string; arquivoNome: string; arquivoConteudo: string; mime: string };
}

export interface ProvedorDePagamento {
  readonly nome: string;
  gerarPix(pedido: PedidoDeCobranca): Promise<CobrancaGerada>;
  gerarBoleto(pedido: PedidoDeCobranca): Promise<CobrancaGerada>;
}
