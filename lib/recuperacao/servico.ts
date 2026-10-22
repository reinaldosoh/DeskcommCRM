/**
 * As operações da Bella, sem MCP e sem Supabase: recebem um repositório e um
 * provedor de pagamento. As tools em `lib/mcp/tools/recuperacao.ts` são só a
 * casca; o laboratório chama isto direto, com o repositório em memória.
 *
 * Três regras atravessam tudo:
 *  1. Só a dívida do CONTATO DA CONVERSA — dívida de outra pessoa é
 *     `fora_da_conversa`, exista ou não (um id não vira oráculo).
 *  2. Nenhum valor antes da identidade confirmada.
 *  3. O modelo nunca dita número: o acordo é recalculado aqui a partir do
 *     pedido, e só entra se couber na política do credor.
 */
import { z } from "zod";

import { formatCentsBRL } from "@/lib/money";

/** Valor em reais com espaço comum (o Intl usa NBSP, que o modelo copia mal). */
function reais(cents: number): string {
  return formatCentsBRL(cents).replace(/\u00a0/g, " ");
}

import { ESTADO_INICIAL, registrarTentativa, type EstadoDeIdentidade } from "./identidade";
import type { ProvedorDePagamento } from "./pagamento/tipos";
import {
  POLITICA_PADRAO,
  avaliarPedido,
  diasDeAtraso,
  escadaDeOfertas,
  type PedidoDoDevedor,
} from "./politica";
import type { CarteiraRow, DividaRow, RepositorioDeRecuperacao } from "./repositorio";
import type { Desfecho, Divida, PoliticaDeNegociacao, Proposta } from "./tipos";

export interface ContextoDeCobranca {
  repo: RepositorioDeRecuperacao;
  /** O contato da conversa — vem do turno, nunca do modelo. */
  contatoId: string;
  agora: Date;
  provedor: ProvedorDePagamento;
  sourceJobId: string | null;
}

// ---------------------------------------------------------------------------
// política da carteira
// ---------------------------------------------------------------------------

const politicaSchema = z
  .object({
    faixas: z
      .array(
        z.object({
          diasMinimos: z.number().int().min(0),
          descontoInicialPct: z.number().min(0).max(100),
          descontoMaximoPct: z.number().min(0).max(100),
        }),
      )
      .min(1),
    maxParcelas: z.number().int().min(1).max(120),
    entradaMinimaPct: z.number().min(0).max(100),
    parcelaMinimaCents: z.number().int().min(0),
    prazoPrimeiroPagamentoDias: z.number().int().min(0).max(60),
    descontoNoParceladoPct: z.number().min(0).max(100),
  })
  .partial();

/** A política gravada na carteira, sobre o padrão. Configuração inválida é erro, não chute. */
export function lerPolitica(json: unknown): PoliticaDeNegociacao {
  const r = politicaSchema.safeParse(json ?? {});
  if (!r.success) throw new Error(`recuperacao_politica_invalida: ${r.error.issues[0]?.message ?? "formato"}`);
  return { ...POLITICA_PADRAO, ...r.data };
}

/** Meia-noite (UTC) do dia de hoje em São Paulo: as datas de vencimento são do calendário local. */
export function hojeLocal(agora: Date, fuso = "America/Sao_Paulo"): Date {
  const dia = new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(agora);
  return new Date(`${dia}T00:00:00Z`);
}

function dataBR(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export function descreverProposta(p: Proposta): string {
  if (p.forma === "a_vista") {
    const desc = p.descontoPct > 0 ? ` (${p.descontoPct}% de desconto)` : "";
    return `${reais(p.totalCents)} à vista${desc}, para pagar até ${dataBR(p.primeiroVencimento)}`;
  }
  return (
    `entrada de ${reais(p.entradaCents)} até ${dataBR(p.primeiroVencimento)} + ` +
    `${p.parcelas - 1}x de ${reais(p.parcelaCents)} (total ${reais(p.totalCents)})`
  );
}

function paraDivida(d: DividaRow, carteira: CarteiraRow): Divida {
  return {
    id: d.id,
    credor: carteira.credor_nome,
    produto: d.produto,
    saldoCents: Number(d.valor_devido_cents),
    vencimentoOriginal: d.vencimento_original,
    parcelasVencidas: d.parcelas_vencidas ?? undefined,
  };
}

function estadoDe(d: DividaRow): EstadoDeIdentidade {
  return {
    tentativas: d.identidade_tentativas,
    verificadoEm: d.identidade_verificada_em,
    bloqueadoAte: d.identidade_bloqueada_ate,
  };
}

const ABERTAS: ReadonlyArray<DividaRow["status"]> = ["aberta", "em_acordo"];

// ---------------------------------------------------------------------------
// identidade
// ---------------------------------------------------------------------------

export type ResultadoIdentidade =
  | { status: "verificado"; mensagem: string }
  | { status: "nao_confere"; tentativas_restantes: number; mensagem: string }
  | { status: "resposta_invalida"; mensagem: string }
  | { status: "bloqueado"; mensagem: string }
  | { status: "sem_divida"; mensagem: string }
  | { status: "sem_cadastro"; mensagem: string };

export async function verificarIdentidade(ctx: ContextoDeCobranca, resposta: string): Promise<ResultadoIdentidade> {
  const dividas = (await ctx.repo.dividasDoContato(ctx.contatoId)).filter((d) => ABERTAS.includes(d.status));
  if (dividas.length === 0) {
    return { status: "sem_divida", mensagem: "não há pendência em aberto para este contato" };
  }
  const comCpf = dividas.find((d) => d.cpf_prefixo);
  if (!comCpf?.cpf_prefixo) {
    return {
      status: "sem_cadastro",
      mensagem: "o credor não enviou o CPF deste cadastro — não dá para confirmar identidade; transfira para um humano",
    };
  }

  // A identidade é da PESSOA: o estado vale para todas as dívidas dela.
  const estado = estadoDe(comCpf);
  const r = registrarTentativa(estado.verificadoEm ? estado : { ...ESTADO_INICIAL, ...estado }, comCpf.cpf_prefixo, resposta, ctx.agora);
  for (const d of dividas) {
    await ctx.repo.atualizarDivida(d.id, {
      identidade_tentativas: r.estado.tentativas,
      identidade_verificada_em: r.estado.verificadoEm,
      identidade_bloqueada_ate: r.estado.bloqueadoAte,
    });
  }

  switch (r.status) {
    case "verificado":
      if (!estado.verificadoEm) {
        await tabular(ctx, { dividaId: comCpf.id, desfecho: "identidade_confirmada" });
      }
      return { status: "verificado", mensagem: "identidade confirmada — pode consultar a dívida e falar de valores" };
    case "nao_confere":
      return {
        status: "nao_confere",
        tentativas_restantes: r.restantes,
        mensagem: "os dígitos não conferem; peça de novo com gentileza, sem dizer quais seriam os certos",
      };
    case "resposta_invalida":
      return { status: "resposta_invalida", mensagem: "não entendi os 3 primeiros dígitos; peça de novo" };
    case "bloqueado":
      return {
        status: "bloqueado",
        mensagem:
          "tentativas esgotadas; não fale de valores. Diga que por segurança a confirmação fica pausada e ofereça falar com um atendente",
      };
  }
}

function identidadeOk(dividas: DividaRow[]): boolean {
  return dividas.some((d) => d.identidade_verificada_em !== null);
}

// ---------------------------------------------------------------------------
// consulta e simulação
// ---------------------------------------------------------------------------

const RECUSA_IDENTIDADE = {
  permitido: false as const,
  motivo: "identidade_nao_confirmada" as const,
  mensagem: "confirme a identidade (3 primeiros dígitos do CPF) antes de falar de valores",
};

const FORA_DA_CONVERSA = {
  permitido: false as const,
  motivo: "fora_da_conversa" as const,
  mensagem: "esta dívida não é da pessoa desta conversa — siga com quem está falando",
};

export async function consultarDividas(ctx: ContextoDeCobranca) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  const abertas = todas.filter((d) => ABERTAS.includes(d.status));
  if (abertas.length === 0) return { permitido: true as const, dividas: [], mensagem: "nenhuma pendência em aberto" };
  if (!identidadeOk(todas)) {
    const credores = new Set<string>();
    for (const d of abertas) {
      const c = await ctx.repo.carteira(d.carteira_id);
      if (c) credores.add(c.credor_nome);
    }
    return { ...RECUSA_IDENTIDADE, credores: [...credores] };
  }

  const hoje = hojeLocal(ctx.agora);
  const dividas = [];
  for (const d of abertas) {
    const carteira = await ctx.repo.carteira(d.carteira_id);
    if (!carteira) continue;
    const divida = paraDivida(d, carteira);
    const politica = lerPolitica(carteira.politica);
    const acordo = d.status === "em_acordo" ? await ctx.repo.acordoAtivo(d.id) : null;
    dividas.push({
      divida_id: d.id,
      credor: divida.credor,
      produto: divida.produto,
      valor_atualizado: reais(divida.saldoCents),
      dias_de_atraso: diasDeAtraso(divida, hoje),
      status: d.status,
      acordo_ativo: acordo !== null,
      ofertas:
        d.status === "aberta"
          ? escadaDeOfertas(divida, politica, hoje).map((p, i) => ({ ordem: i + 1, texto: descreverProposta(p), ...p }))
          : [],
      limites: { max_parcelas: politica.maxParcelas },
    });
  }
  return {
    permitido: true as const,
    dividas,
    mensagem:
      "apresente UMA oferta por vez, na ordem; só desça para a próxima se a pessoa recusar ou disser que não cabe",
  };
}

async function dividaDoContato(ctx: ContextoDeCobranca, dividaId: string) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  const d = todas.find((x) => x.id === dividaId);
  if (!d) return { erro: FORA_DA_CONVERSA };
  if (!identidadeOk(todas)) return { erro: RECUSA_IDENTIDADE };
  const carteira = await ctx.repo.carteira(d.carteira_id);
  if (!carteira) return { erro: FORA_DA_CONVERSA };
  return { d, carteira, divida: paraDivida(d, carteira), politica: lerPolitica(carteira.politica) };
}

export async function simularAcordo(ctx: ContextoDeCobranca, dividaId: string, pedido: PedidoDoDevedor) {
  const r = await dividaDoContato(ctx, dividaId);
  if ("erro" in r) return r.erro;
  if (r.d.status !== "aberta") {
    return { permitido: false as const, motivo: "divida_nao_aberta" as const, mensagem: `esta dívida está ${r.d.status}` };
  }
  const a = avaliarPedido(r.divida, r.politica, hojeLocal(ctx.agora), pedido);
  if (a.aceitavel) {
    return { permitido: true as const, aceitavel: true as const, texto: descreverProposta(a.proposta), proposta: a.proposta };
  }
  return {
    permitido: true as const,
    aceitavel: false as const,
    motivo: a.motivo,
    detalhe: a.detalhe,
    contraproposta: { texto: descreverProposta(a.contraproposta), ...a.contraproposta },
  };
}

// ---------------------------------------------------------------------------
// fechar o acordo e mandar o pagamento NA HORA (a Mia não mandava)
// ---------------------------------------------------------------------------

export async function fecharAcordo(
  ctx: ContextoDeCobranca,
  dividaId: string,
  pedido: PedidoDoDevedor,
  meio: "pix" | "boleto",
  devedorNome: string,
  /** O total que a pessoa aceitou na conversa: se a política recalcular outro, não fecha. */
  totalAceitoCents?: number,
) {
  const r = await dividaDoContato(ctx, dividaId);
  if ("erro" in r) return r.erro;
  if (r.d.status !== "aberta" || (await ctx.repo.acordoAtivo(dividaId))) {
    return {
      permitido: false as const,
      motivo: "acordo_ja_existe" as const,
      mensagem: "já existe um acordo ativo para esta dívida — reenvie o pagamento dele, não feche outro",
    };
  }
  const a = avaliarPedido(r.divida, r.politica, hojeLocal(ctx.agora), pedido);
  if (!a.aceitavel) {
    return {
      permitido: false as const,
      motivo: a.motivo,
      detalhe: a.detalhe,
      contraproposta: { texto: descreverProposta(a.contraproposta), ...a.contraproposta },
    };
  }
  const p = a.proposta;
  // Tolerância de R$ 1: arredondamento de quem digitou o valor, não condição diferente.
  if (totalAceitoCents !== undefined && Math.abs(p.totalCents - totalAceitoCents) > 100) {
    return {
      permitido: false as const,
      motivo: "difere_do_aceito" as const,
      mensagem:
        "este pedido dá um total diferente do que a pessoa aceitou — não feche: apresente a condição abaixo e peça um novo aceite",
      proposta: { texto: descreverProposta(p), ...p },
    };
  }
  const { id: acordoId } = await ctx.repo.inserirAcordo({
    divida_id: dividaId,
    contact_id: ctx.contatoId,
    forma: p.forma,
    total_cents: p.totalCents,
    desconto_pct: p.descontoPct,
    desconto_cents: p.descontoCents,
    parcelas: p.parcelas,
    entrada_cents: p.entradaCents,
    parcela_cents: p.parcelaCents,
    primeiro_vencimento: p.primeiroVencimento,
    meio_pagamento: meio,
    source_job_id: ctx.sourceJobId,
  });

  const pedidoDeCobranca = {
    acordoId,
    parcela: 1,
    valorCents: p.entradaCents,
    vencimento: p.primeiroVencimento,
    devedorNome,
    descricao: `Acordo ${r.divida.credor} - ${r.divida.produto}`,
  };
  const cobranca =
    meio === "pix" ? await ctx.provedor.gerarPix(pedidoDeCobranca) : await ctx.provedor.gerarBoleto(pedidoDeCobranca);
  await ctx.repo.inserirCobranca({
    acordo_id: acordoId,
    parcela: 1,
    valor_cents: p.entradaCents,
    vencimento: p.primeiroVencimento,
    meio,
    provedor: cobranca.provedor,
    id_externo: cobranca.idExterno,
    teste: cobranca.teste,
    pix_copia_e_cola: cobranca.pix?.copiaECola ?? null,
    boleto_linha_digitavel: cobranca.boleto?.linhaDigitavel ?? null,
  });
  await ctx.repo.atualizarDivida(dividaId, { status: "em_acordo", retornar_em: null });
  await tabular(ctx, { dividaId, desfecho: "acordo_realizado" });

  return {
    permitido: true as const,
    acordo_id: acordoId,
    resumo: descreverProposta(p),
    pagamento: {
      meio,
      valor: reais(p.entradaCents),
      vencimento: dataBR(p.primeiroVencimento),
      pix_copia_e_cola: cobranca.pix?.copiaECola,
      boleto_linha_digitavel: cobranca.boleto?.linhaDigitavel,
      teste: cobranca.teste,
    },
    mensagem: cobranca.teste
      ? "acordo registrado. Envie AGORA o código de pagamento, e avise que é um PAGAMENTO DE TESTE (período de validação) — não deve ser pago"
      : "acordo registrado. Envie AGORA o código de pagamento",
  };
}

// ---------------------------------------------------------------------------
// tabulação
// ---------------------------------------------------------------------------

export async function tabular(
  ctx: ContextoDeCobranca,
  t: { dividaId?: string | null; desfecho: Desfecho; motivo?: string | null; retornarEm?: string | null },
) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  if (t.dividaId && !todas.some((d) => d.id === t.dividaId)) return FORA_DA_CONVERSA;
  if (t.desfecho === "retornar_contato" && !t.retornarEm) {
    return { permitido: false as const, motivo: "retorno_sem_data" as const, mensagem: "informe quando retornar (retornar_em)" };
  }

  await ctx.repo.inserirTabulacao({
    divida_id: t.dividaId ?? null,
    contact_id: ctx.contatoId,
    desfecho: t.desfecho,
    motivo: t.motivo ?? null,
    source_job_id: ctx.sourceJobId,
  });

  const alvo = t.dividaId ? todas.filter((d) => d.id === t.dividaId) : todas;
  for (const d of t.desfecho === "opt_out" ? todas : alvo) {
    await ctx.repo.atualizarDivida(d.id, {
      ultimo_desfecho: t.desfecho,
      ...(t.desfecho === "opt_out" ? { opt_out_em: ctx.agora.toISOString(), retornar_em: null } : {}),
      ...(t.desfecho === "retornar_contato" ? { retornar_em: t.retornarEm } : {}),
    });
  }
  return { permitido: true as const, registrado: t.desfecho };
}
