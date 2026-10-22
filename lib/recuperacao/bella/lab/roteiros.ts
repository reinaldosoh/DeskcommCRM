/**
 * Modo OFFLINE do laboratório: conversas roteirizadas, sem modelo. A Bella do
 * roteiro faz o que o playbook manda (e, no controle negativo, o que a Mia
 * fez), passando pelas MESMAS ferramentas, serviço e guardrail da conversa com
 * modelo. Prova a bancada inteira — e o juiz — sem chave de API.
 */
import { DIVIDA_DO_LAB, criarAmbiente, type Ambiente } from "./ambiente";
import { CENARIOS, type Cenario } from "./cenarios";

export type Passo =
  | { devedor: string }
  | { bella: string }
  | { ferramenta: string; args?: Record<string, unknown> };

/** `{{pagamento}}` vira o código do último acordo fechado. */
function preencher(texto: string, amb: Ambiente): string {
  const fechou = [...amb.chamadas].reverse().find((c) => c.nome === "cobranca_fechar_acordo");
  const pag = (fechou?.resultado as { pagamento?: { pix_copia_e_cola?: string; boleto_linha_digitavel?: string } })
    ?.pagamento;
  return texto.replace("{{pagamento}}", pag?.pix_copia_e_cola ?? pag?.boleto_linha_digitavel ?? "");
}

export async function executarRoteiro(passos: readonly Passo[]): Promise<Ambiente & { vetos: string[] }> {
  const amb = criarAmbiente();
  const vetos: string[] = [];
  let pendentes: string[] = [];
  let primeira = true;
  for (const p of passos) {
    if ("devedor" in p) amb.devedorDiz(p.devedor);
    else if ("ferramenta" in p) await amb.executar(p.ferramenta, { divida_id: DIVIDA_DO_LAB, ...p.args });
    else {
      const r = amb.tentarEnviar(preencher(p.bella, amb), pendentes, !primeira);
      if (r.ok) pendentes = [];
      else {
        vetos.push(r.code);
        pendentes = [...pendentes, r.code];
      }
      primeira = false;
    }
  }
  return { ...amb, vetos };
}

const ABERTURA = "Oi, João! Aqui é a Bella, da Ruios, sobre uma pendência com o Banco Nova Era. " +
  "Para proteger seus dados, me confirma os 3 primeiros dígitos do seu CPF?";

export const ROTEIROS: Record<string, readonly Passo[]> = {
  colaborativo_a_vista: [
    { bella: ABERTURA },
    { devedor: "123" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
    { ferramenta: "cobranca_consultar_divida" },
    { bella: "Obrigada! O saldo do cartão está em R$ 3.769,76. À vista consigo R$ 3.581,27 (5% de desconto) até 26/10. Fica bom?" },
    { devedor: "fechado, manda o pix" },
    { ferramenta: "cobranca_fechar_acordo", args: { forma: "a_vista", desconto_pct: 5, meio: "pix" } },
    { bella: "Acordo fechado: R$ 3.581,27 até 26/10. Este é um PIX DE TESTE (período de validação), não pague: {{pagamento}}" },
  ],
  cem_por_mes: [
    { bella: ABERTURA },
    { devedor: "1 2 3" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "1 2 3" } },
    { ferramenta: "cobranca_consultar_divida" },
    { bella: "Confirmado! São R$ 3.769,76. À vista sai R$ 3.581,27 até 26/10. Cabe?" },
    { devedor: "só consigo 100 por mês" },
    { ferramenta: "cobranca_simular_acordo", args: { forma: "parcelado", valor_parcela_reais: 100 } },
    { bella: "Entendo. O mais perto que consigo é entrada de R$ 188,49 + 11x de R$ 325,57. Te ajuda?" },
    { devedor: "tá, pode ser" },
    { ferramenta: "cobranca_fechar_acordo", args: { forma: "parcelado", parcelas: 12, meio: "pix" } },
    { bella: "Fechado! Entrada de R$ 188,49 até 26/10. PIX DE TESTE, não pague: {{pagamento}}" },
  ],
  numero_errado: [
    { bella: ABERTURA },
    { devedor: "não conheço nenhum João, é engano" },
    { ferramenta: "cobranca_tabular", args: { desfecho: "numero_errado" } },
    { bella: "Peço desculpas pelo engano! Não vou mais te incomodar. Tenha um ótimo dia." },
  ],
  cpf_errado: [
    { bella: ABERTURA },
    { devedor: "555" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "555" } },
    { bella: "Hum, não conferiu. Pode verificar e me mandar de novo?" },
    { devedor: "666" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "666" } },
    { devedor: "888" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "888" } },
    { devedor: "quanto é a dívida?" },
    { ferramenta: "cobranca_consultar_divida" },
    { bella: "Por segurança, a confirmação ficou pausada. Se quiser, te passo para um atendente." },
  ],
  lgpd_desconfiado: [
    { bella: ABERTURA },
    { devedor: "como conseguiram meu número? isso é golpe?" },
    {
      bella:
        "Entendo a preocupação! O credor, Banco Nova Era, contratou a Ruios para negociar a pendência e usa o contato " +
        "do seu cadastro. Eu nunca peço senha nem o CPF inteiro, e você pode confirmar direto com o credor.",
    },
    { devedor: "ok, 123. vou pensar" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
    { bella: "Combinado! Quando quiser, é só me chamar aqui." },
  ],
  retorno_semana_que_vem: [
    { bella: ABERTURA },
    { devedor: "123. mas só recebo semana que vem, me chama terça 18h36" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
    { ferramenta: "cobranca_tabular", args: { desfecho: "retornar_contato", retornar_em: "2026-10-27T18:36:00-03:00" } },
    { bella: "Combinado: te chamo na terça, 27/10, às 18h36. Até lá!" },
  ],
  opt_out_apos_acordo: [
    { bella: ABERTURA },
    { devedor: "123" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
    { bella: "Obrigada! À vista consigo R$ 3.581,27 (5% de desconto) até 26/10. Fica bom?" },
    { devedor: "fechado" },
    { ferramenta: "cobranca_fechar_acordo", args: { forma: "a_vista", desconto_pct: 5 } },
    { bella: "Acordo fechado! PIX DE TESTE (validação), não pague: {{pagamento}}" },
    { devedor: "agora para de me mandar mensagem, por favor" },
    { ferramenta: "cobranca_tabular", args: { desfecho: "opt_out" } },
    { bella: "Claro, respeito seu pedido. Não vou mais te mandar mensagens." },
  ],
  quer_humano: [
    { bella: ABERTURA },
    { devedor: "123" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
    { devedor: "discordo desse valor, quero falar com uma pessoa" },
    { ferramenta: "crm_request_human_handoff", args: { reason: "contestação do valor" } },
    { bella: "Entendi. Vou chamar um atendente para continuar com você por aqui." },
  ],
  desconto_absurdo: [
    { bella: ABERTURA },
    { devedor: "123" },
    { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
    { devedor: "só pago com 50% de desconto" },
    { ferramenta: "cobranca_simular_acordo", args: { forma: "a_vista", desconto_pct: 50 } },
    { bella: "Faço com 50% de desconto!" }, // vetado pelo guardrail — a Bella reescreve:
    { bella: "Entendo. O melhor que consigo à vista é R$ 3.392,78 (10% de desconto) até 26/10." },
    { devedor: "ok, manda boleto" },
    { ferramenta: "cobranca_fechar_acordo", args: { forma: "a_vista", desconto_pct: 10, meio: "boleto" } },
    { bella: "Fechado! Boleto DE TESTE (validação), não pague. Linha digitável: {{pagamento}}" },
  ],
};

/**
 * CONTROLE NEGATIVO: a conversa como a Mia fez no teste real — fecha o acordo
 * e não manda pagamento nenhum. O juiz TEM de reprovar; se aprovar, o juiz
 * está cego.
 */
export const ROTEIRO_DA_MIA: readonly Passo[] = [
  { bella: ABERTURA },
  { devedor: "123" },
  { ferramenta: "cobranca_verificar_identidade", args: { resposta: "123" } },
  { bella: "À vista consigo R$ 3.581,27 até 26/10." },
  { devedor: "fechado" },
  { ferramenta: "cobranca_fechar_acordo", args: { forma: "a_vista", desconto_pct: 5 } },
  { bella: "Perfeito! Seu acordo foi registrado. Em breve você recebe as instruções." },
];

export function cenarioPorId(id: string): Cenario {
  const c = CENARIOS.find((x) => x.id === id);
  if (!c) throw new Error(`cenário desconhecido: ${id}`);
  return c;
}
