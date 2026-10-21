/**
 * Capacidades de RECUPERAÇÃO DE CRÉDITO — a agente Bella (Pacare).
 *
 * Casca fina sobre `lib/recuperacao/servico.ts`: aqui só se monta o contexto
 * (repositório Supabase da organização, contato do turno, provedor de
 * pagamento) e se traduz o input. Toda regra mora no serviço, que o
 * laboratório exercita sem banco.
 *
 * TODAS exigem conversa: sem `ctx.contatoDoTurno` (rota HTTP, MCP externo) não
 * há devedor para atender, e a resposta é `sem_conversa` — cobrança não se
 * faz "em nome de alguém" por fora do atendimento.
 */
import { z } from "zod";

import { provedorDePagamento } from "@/lib/recuperacao/pagamento/fake";
import { repositorioSupabase } from "@/lib/recuperacao/repositorio";
import {
  consultarDividas,
  fecharAcordo,
  simularAcordo,
  tabular,
  verificarIdentidade,
  type ContextoDeCobranca,
} from "@/lib/recuperacao/servico";
import { DESFECHOS } from "@/lib/recuperacao/tipos";
import type { PedidoDoDevedor } from "@/lib/recuperacao/politica";

import type { McpContext, McpToolDefinition } from "../types";

const SEM_CONVERSA = {
  permitido: false,
  motivo: "sem_conversa",
  mensagem: "cobrança só acontece dentro de uma conversa com o próprio devedor",
} as const;

function contextoDe(ctx: McpContext): ContextoDeCobranca | null {
  if (!ctx.contatoDoTurno) return null;
  return {
    repo: repositorioSupabase(ctx.supabase, ctx.organizationId),
    contatoId: ctx.contatoDoTurno,
    agora: new Date(),
    provedor: provedorDePagamento(),
    sourceJobId: ctx.sourceJobId ?? null,
  };
}

const reais = z.number().positive().max(10_000_000);
const paraCents = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100));

const pedidoShape = {
  divida_id: z.string().uuid().describe("A dívida, como veio em cobranca_consultar_divida."),
  forma: z.enum(["a_vista", "parcelado"]),
  parcelas: z.number().int().min(2).max(120).optional().describe("Total de parcelas, CONTANDO a entrada."),
  entrada_reais: reais.optional().describe("Entrada que a pessoa quer dar, em reais."),
  valor_parcela_reais: reais.optional().describe("Quanto cabe por mês, em reais (\"consigo 100 por mês\")."),
  total_reais: reais.optional().describe("À vista: quanto a pessoa propõe pagar para quitar, em reais."),
  desconto_pct: z.number().min(0).max(100).optional().describe("À vista: desconto da oferta escolhida."),
};

export function pedidoDe(input: {
  forma: "a_vista" | "parcelado";
  parcelas?: number;
  entrada_reais?: number;
  valor_parcela_reais?: number;
  total_reais?: number;
  desconto_pct?: number;
}): PedidoDoDevedor {
  return {
    forma: input.forma,
    parcelas: input.parcelas,
    entradaCents: paraCents(input.entrada_reais),
    valorParcelaDesejadoCents: paraCents(input.valor_parcela_reais),
    totalDesejadoCents: paraCents(input.total_reais),
    descontoPct: input.desconto_pct,
  };
}

// ---------------------------------------------------------------------------

const identidadeShape = {
  resposta: z.string().min(1).max(40).describe("O que a pessoa respondeu quando pediu os 3 primeiros dígitos do CPF."),
};

export const cobrancaVerificarIdentidade: McpToolDefinition<typeof identidadeShape> = {
  name: "cobranca_verificar_identidade",
  description:
    "Confere os 3 primeiros dígitos do CPF que a pessoa informou contra o cadastro do credor. " +
    "Obrigatório antes de qualquer valor. Nunca diga quais seriam os dígitos certos. " +
    "Após 3 erros, bloqueia por 1 hora.",
  inputSchema: identidadeShape,
  category: "write",
  // Só o agente (token efêmero) alcança: nenhuma pessoa tem `ai_operator`.
  // Gente mexe em acordo pela tela, com papel `manager`.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  // A resposta É parte do CPF: não vai para o log de auditoria.
  redigirParaAuditoria: (args) => ({ ...args, resposta: "[redigido]" }),
  handler: async (input, ctx) => {
    const c = contextoDe(ctx);
    if (!c) return SEM_CONVERSA;
    return verificarIdentidade(c, input.resposta);
  },
};

export const cobrancaConsultarDivida: McpToolDefinition<Record<string, never>> = {
  name: "cobranca_consultar_divida",
  description:
    "Traz as dívidas em aberto da pessoa desta conversa, com valor atualizado e a escada de ofertas " +
    "(à vista com desconto inicial, desconto máximo, parcelado). Sem identidade confirmada, devolve só " +
    "o nome do credor. Nunca invente ou arredonde um valor: repita o texto da oferta.",
  inputSchema: {},
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const c = contextoDe(ctx);
    if (!c) return SEM_CONVERSA;
    return consultarDividas(c);
  },
};

export const cobrancaSimularAcordo: McpToolDefinition<typeof pedidoShape> = {
  name: "cobranca_simular_acordo",
  description:
    "Simula o que a pessoa pediu (\"consigo 100 por mês\", \"pago 3 mil à vista\", \"em 10 vezes\") contra a " +
    "política do credor. Se não couber, devolve a contraproposta mais próxima permitida. Use SEMPRE antes de " +
    "dizer um número que não estava nas ofertas.",
  inputSchema: pedidoShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const c = contextoDe(ctx);
    if (!c) return SEM_CONVERSA;
    return simularAcordo(c, input.divida_id, pedidoDe(input));
  },
};

const fecharShape = {
  ...pedidoShape,
  meio: z.enum(["pix", "boleto"]).default("pix").describe("Como a pessoa quer pagar."),
};

export const cobrancaFecharAcordo: McpToolDefinition<typeof fecharShape> = {
  name: "cobranca_fechar_acordo",
  description:
    "Registra o acordo que a pessoa ACEITOU com clareza (\"fechado\", \"pode ser\") e gera na hora o PIX ou " +
    "boleto da entrada/à vista. O valor é recalculado pela política — passe o mesmo pedido da oferta aceita. " +
    "Depois, envie o código de pagamento imediatamente.",
  inputSchema: fecharShape,
  category: "write",
  // Só o agente (token efêmero) alcança: nenhuma pessoa tem `ai_operator`.
  // Gente mexe em acordo pela tela, com papel `manager`.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const c = contextoDe(ctx);
    if (!c) return SEM_CONVERSA;
    const { data: contato } = await ctx.supabase
      .from("contacts")
      .select("name, display_name")
      .eq("organization_id", ctx.organizationId)
      .eq("id", c.contatoId)
      .maybeSingle();
    const nome = (contato?.display_name || contato?.name || "Cliente") as string;
    return fecharAcordo(c, input.divida_id, pedidoDe(input), input.meio ?? "pix", nome);
  },
};

const tabularShape = {
  desfecho: z.enum(DESFECHOS),
  divida_id: z.string().uuid().optional(),
  motivo: z.string().max(200).optional().describe("Motivo curto, sem dado pessoal (ex.: \"desempregado\")."),
  retornar_em: z.string().datetime({ offset: true }).optional().describe("Obrigatório em retornar_contato (ISO 8601)."),
};

export const cobrancaTabular: McpToolDefinition<typeof tabularShape> = {
  name: "cobranca_tabular",
  description:
    "Registra o desfecho da conversa para o painel: acordo_nao_realizado, contra_proposta, retornar_contato " +
    "(com retornar_em), recusa_de_informacao, cobranca_indisponivel, numero_errado ou opt_out. " +
    "opt_out para TODA mensagem ativa a esta pessoa. Identidade e acordo são tabulados sozinhos.",
  inputSchema: tabularShape,
  category: "write",
  // Só o agente (token efêmero) alcança: nenhuma pessoa tem `ai_operator`.
  // Gente mexe em acordo pela tela, com papel `manager`.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const c = contextoDe(ctx);
    if (!c) return SEM_CONVERSA;
    return tabular(c, {
      dividaId: input.divida_id ?? null,
      desfecho: input.desfecho,
      motivo: input.motivo ?? null,
      retornarEm: input.retornar_em ?? null,
    });
  },
};
