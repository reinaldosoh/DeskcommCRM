/**
 * Capacidades de RECUPERAÇÃO DE CRÉDITO — a agente de cobrança (Bella).
 * Pacote próprio, `cobrar`: um agente de atendimento comum não as recebe.
 */
import { declararTools } from "./tipos";

export const TOOLS_RECUPERACAO = declararTools([
  {
    name: "cobranca_verificar_identidade",
    category: "write",
    rotulo: "Confirmar a identidade do devedor",
    explicacao:
      "Confere os três primeiros dígitos do CPF antes de qualquer valor ser dito, com limite de tentativas para ninguém adivinhar.",
    oQueToca: "Dívidas da carteira",
    risco: "atencao",
    pacotes: ["cobrar"],
  },
  {
    name: "cobranca_consultar_divida",
    category: "read",
    rotulo: "Consultar a dívida e as ofertas",
    explicacao:
      "Mostra ao assistente o valor atualizado e as ofertas que o credor autorizou, para ele negociar sem inventar número.",
    oQueToca: "Dívidas da carteira",
    risco: "seguro",
    pacotes: ["cobrar"],
  },
  {
    name: "cobranca_simular_acordo",
    category: "read",
    rotulo: "Simular um acordo",
    explicacao:
      "Testa o que o devedor pediu contra a política do credor e devolve a contraproposta mais próxima quando não cabe.",
    oQueToca: "Política de negociação",
    risco: "seguro",
    pacotes: ["cobrar"],
  },
  {
    name: "cobranca_fechar_acordo",
    category: "write",
    rotulo: "Fechar o acordo e gerar o pagamento",
    explicacao:
      "Registra o acordo aceito pelo devedor e gera na hora o PIX ou boleto da primeira parcela (de teste durante a validação).",
    oQueToca: "Acordos e cobranças",
    risco: "atencao",
    pacotes: ["cobrar"],
  },
  {
    name: "cobranca_tabular",
    category: "write",
    rotulo: "Registrar o desfecho da conversa",
    explicacao:
      "Marca como a conversa terminou (recusa, retorno agendado, número errado, pedido para não receber mais) para o painel e a régua.",
    oQueToca: "Resultados da cobrança",
    risco: "atencao",
    pacotes: ["cobrar"],
  },
]);
