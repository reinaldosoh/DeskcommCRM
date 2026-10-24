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

import { recursosDeAjuda } from "./cuidado";
import { identidadeVigente, registrarTentativa, type EstadoDeIdentidade } from "./identidade";
import type { ProvedorDePagamento } from "./pagamento/tipos";
import {
  POLITICA_PADRAO,
  avaliarPedido,
  diasDeAtraso,
  escadaDeOfertas,
  pctBR,
  proximoDegrauAVista,
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
    passoDescontoPct: z.number().min(0.1).max(10),
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
    const desc = p.descontoPct > 0 ? ` (${pctBR(p.descontoPct)} de desconto)` : "";
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

/** O desconto já liberado na negociação (o banco devolve `numeric` como texto). */
function liberadoDe(d: DividaRow): number | null {
  return d.desconto_liberado_pct === null || d.desconto_liberado_pct === undefined ? null : Number(d.desconto_liberado_pct);
}

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
  const vigente = identidadeVigente(estado.verificadoEm, ctx.agora);
  const r = registrarTentativa(estado, comCpf.cpf_prefixo, resposta, ctx.agora);
  for (const d of dividas) {
    await ctx.repo.atualizarDivida(d.id, {
      identidade_tentativas: r.estado.tentativas,
      identidade_verificada_em: r.estado.verificadoEm,
      identidade_bloqueada_ate: r.estado.bloqueadoAte,
    });
  }

  switch (r.status) {
    case "verificado":
      if (!vigente) {
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

/** Confirmada nos últimos 90 dias (`VALIDADE_DA_IDENTIDADE_DIAS`): o retorno não pede o CPF de novo. */
function identidadeOk(dividas: DividaRow[], agora: Date): boolean {
  return dividas.some((d) => identidadeVigente(d.identidade_verificada_em, agora));
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

const PAUSADA_POR_CUIDADO = {
  permitido: false as const,
  motivo: "cobranca_pausada_por_cuidado" as const,
  mensagem:
    "a cobrança desta pessoa está pausada por um sinal de risco à vida. Não fale de dívida, valor nem retorno: " +
    "acolha, reforce os contatos de ajuda e diga que um atendente vai continuar",
};

function emCuidado(dividas: DividaRow[]): boolean {
  return dividas.some((d) => d.cuidado_em !== null && d.cuidado_em !== undefined);
}

export async function consultarDividas(ctx: ContextoDeCobranca) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  if (emCuidado(todas)) return PAUSADA_POR_CUIDADO;
  const abertas = todas.filter((d) => ABERTAS.includes(d.status));
  if (abertas.length === 0) return { permitido: true as const, dividas: [], mensagem: "nenhuma pendência em aberto" };
  if (!identidadeOk(todas, ctx.agora)) {
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
          ? escadaDeOfertas(divida, politica, hoje, liberadoDe(d)).map((p, i) => ({ ordem: i + 1, texto: descreverProposta(p), ...p }))
          : [],
      limites: { max_parcelas: politica.maxParcelas },
    });
  }
  return {
    permitido: true as const,
    dividas,
    mensagem:
      "apresente UMA oferta por vez, na ordem; só desça para a próxima se a pessoa recusar ou disser que não cabe. " +
      "Se o à vista não servir por causa do valor, entenda o porquê e use cobranca_pedir_condicao_melhor — " +
      "um pouco de cada vez; nunca diga que existe um teto",
  };
}

async function dividaDoContato(ctx: ContextoDeCobranca, dividaId: string) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  const d = todas.find((x) => x.id === dividaId);
  if (!d) return { erro: FORA_DA_CONVERSA };
  if (emCuidado(todas)) return { erro: PAUSADA_POR_CUIDADO };
  if (!identidadeOk(todas, ctx.agora)) return { erro: RECUSA_IDENTIDADE };
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
  const a = avaliarPedido(r.divida, r.politica, hojeLocal(ctx.agora), pedido, liberadoDe(r.d));
  if (a.aceitavel) {
    return { permitido: true as const, aceitavel: true as const, texto: descreverProposta(a.proposta), proposta: a.proposta };
  }
  return {
    permitido: true as const,
    aceitavel: false as const,
    motivo: a.motivo,
    detalhe: a.detalhe,
    contraproposta: { texto: descreverProposta(a.contraproposta), ...a.contraproposta },
    ...(pedido.forma === "a_vista"
      ? {
          mensagem:
            "não ofereça o que a pessoa pediu. Apresente a contraproposta ou, se o problema é o valor, " +
            "use cobranca_pedir_condicao_melhor (um degrau de cada vez)",
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// subir o desconto, um degrau de cada vez
// ---------------------------------------------------------------------------

export const OBJECOES = ["valor_total", "parcela", "momento", "desconfianca", "outro"] as const;
export type Objecao = (typeof OBJECOES)[number];

/**
 * "Deixa eu ver se consigo um pouco mais para você": libera o PRÓXIMO degrau
 * do desconto à vista — nunca o teto, nunca dois de uma vez. Exige a objeção
 * (o porquê de não servir) e só sobe um degrau por vez de a pessoa falar: o
 * run que liberou fica gravado, e o mesmo run não sobe de novo.
 */
export async function pedirCondicaoMelhor(
  ctx: ContextoDeCobranca,
  dividaId: string,
  pedido: { objecao: Objecao; oQueAPessoaDisse: string; totalPropostoCents?: number },
) {
  const r = await dividaDoContato(ctx, dividaId);
  if ("erro" in r) return r.erro;
  if (r.d.status !== "aberta") {
    return { permitido: false as const, motivo: "divida_nao_aberta" as const, mensagem: `esta dívida está ${r.d.status}` };
  }
  if (!pedido.oQueAPessoaDisse.trim()) {
    return {
      permitido: false as const,
      motivo: "sem_objecao" as const,
      mensagem: "antes de pedir condição melhor, entenda com a pessoa por que a oferta não serve",
    };
  }
  if (ctx.sourceJobId && r.d.desconto_liberado_job === ctx.sourceJobId) {
    return {
      permitido: false as const,
      motivo: "um_degrau_por_vez" as const,
      mensagem:
        "você já conseguiu uma condição melhor nesta resposta. Apresente-a e espere a pessoa responder; " +
        "não suba de novo agora",
    };
  }
  const degrau = proximoDegrauAVista(r.divida, r.politica, hojeLocal(ctx.agora), liberadoDe(r.d), pedido.totalPropostoCents);
  if (degrau.esgotado) {
    return {
      permitido: true as const,
      conseguiu: false as const,
      mensagem:
        "não há mais margem no à vista. Não diga que chegou a um limite nem que este é o máximo: diga que vai " +
        "manter a condição que já apresentou e procure outro caminho (parcelado, quanto cabe por mês, outra data)",
    };
  }
  await ctx.repo.atualizarDivida(dividaId, {
    desconto_liberado_pct: degrau.descontoPct,
    desconto_liberado_job: ctx.sourceJobId,
  });
  return {
    permitido: true as const,
    conseguiu: true as const,
    nova_oferta: { texto: descreverProposta(degrau.proposta), ...degrau.proposta },
    ...(degrau.alcancaOProposto === false ? { alcanca_o_valor_proposto: false } : {}),
    mensagem:
      "apresente como algo que você conseguiu para a pessoa (\"consegui melhorar um pouco\"), ligado ao que ela " +
      "contou. Uma oferta só; não diga que pode melhorar mais, nem que existe um teto" +
      (degrau.alcancaOProposto === false ? ". Ainda não chega no valor que a pessoa propôs: não prometa chegar" : ""),
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
  const a = avaliarPedido(r.divida, r.politica, hojeLocal(ctx.agora), pedido, liberadoDe(r.d));
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
  t: {
    dividaId?: string | null;
    desfecho: Desfecho;
    motivo?: string | null;
    retornarEm?: string | null;
    /** No retorno: o que a pessoa contou e importa na próxima conversa. */
    contexto?: string | null;
  },
) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  if (t.dividaId && !todas.some((d) => d.id === t.dividaId)) return FORA_DA_CONVERSA;
  if (t.desfecho === "retornar_contato" && !t.retornarEm) {
    return { permitido: false as const, motivo: "retorno_sem_data" as const, mensagem: "informe quando retornar (retornar_em)" };
  }
  // Depois de um sinal de risco, nenhuma volta automática: quem retoma é um humano.
  if (t.desfecho === "retornar_contato" && emCuidado(todas)) return PAUSADA_POR_CUIDADO;

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
      ...(t.desfecho === "retornar_contato"
        ? { retornar_em: t.retornarEm, contexto_do_retorno: t.contexto?.trim() ? t.contexto.trim().slice(0, 600) : null }
        : {}),
    });
  }
  return { permitido: true as const, registrado: t.desfecho };
}

// ---------------------------------------------------------------------------
// sinal de risco à vida
// ---------------------------------------------------------------------------

/**
 * A pessoa falou em se machucar ou em não querer viver: a cobrança PARA para
 * todas as dívidas dela (nenhum valor, nenhum retorno automático) até um
 * humano liberar, e volta os contatos de ajuda da cidade dela. Não exige
 * identidade — o cuidado vem antes de tudo — e não devolve nada da dívida.
 */
export async function registrarCuidado(ctx: ContextoDeCobranca, sinal: string) {
  const todas = await ctx.repo.dividasDoContato(ctx.contatoId);
  for (const d of todas) {
    await ctx.repo.atualizarDivida(d.id, { cuidado_em: d.cuidado_em ?? ctx.agora.toISOString(), retornar_em: null });
  }
  if (todas.length > 0) {
    await ctx.repo.inserirTabulacao({
      divida_id: null,
      contact_id: ctx.contatoId,
      desfecho: "cobranca_indisponivel",
      motivo: `cuidado: ${sinal.slice(0, 160)}`,
      source_job_id: ctx.sourceJobId,
    });
  }
  const comLocal = todas.find((d) => d.devedor_cidade || d.devedor_uf);
  return {
    permitido: true as const,
    cobranca_pausada: true as const,
    ajuda: recursosDeAjuda(comLocal?.devedor_cidade ?? null, comLocal?.devedor_uf ?? null),
    mensagem:
      "cobrança pausada. Passe para um humano com urgência (crm_request_human_handoff). Acolha, pergunte com " +
      "clareza se a pessoa pensa em se machucar e se tem alguém por perto, e passe os contatos acima citando a " +
      "cidade. Use só esses contatos; não fale de valor, acordo ou retorno",
  };
}
