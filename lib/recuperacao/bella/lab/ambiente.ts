/**
 * O "mundo" de uma conversa de laboratório: banco em memória com a dívida do
 * João (os números do teste real da Mia), as ferramentas da Bella ligadas ao
 * serviço de verdade e o guardrail de envio de verdade. Só o banco e o canal
 * são de mentira.
 */
import { markdownParaWhatsapp } from "@/lib/agent-engine/texto/formatacao-whatsapp";
import { pedidoDe } from "@/lib/mcp/tools/recuperacao";

import { avaliarEnvioDeCobranca, type EstadoDaCobrancaNoEnvio } from "../../guardrail";
import { identidadeVigente } from "../../identidade";
import { ProvedorFake } from "../../pagamento/fake";
import { POLITICA_PADRAO, diasDeAtraso, faixaVigente } from "../../politica";
import { repositorioEmMemoria, type EstadoEmMemoria } from "../../repositorio";
import {
  consultarDividas,
  fecharAcordo,
  hojeLocal,
  pedirCondicaoMelhor,
  registrarCuidado,
  simularAcordo,
  type Objecao,
  tabular,
  verificarIdentidade,
  type ContextoDeCobranca,
} from "../../servico";
import type { Desfecho } from "../../tipos";

export const CONTATO_DO_LAB = "c1a00000-0000-4000-8000-000000000001";
export const DIVIDA_DO_LAB = "d1a00000-0000-4000-8000-000000000001";
/** Terça, 20/10/2026, 12h em São Paulo — dentro da janela de contato. */
export const AGORA_DO_LAB = new Date("2026-10-20T15:00:00Z");

export interface Mensagem {
  /** `sistema`: marca do simulador (o tempo avançou), não é fala de ninguém. */
  autor: "bella" | "devedor" | "sistema";
  texto: string;
  /** Vetos do guardrail que a Bella levou antes de esta versão sair. */
  vetos: string[];
  /** Data/hora simulada da mensagem (ISO). */
  em?: string;
}

export interface Chamada {
  nome: string;
  args: Record<string, unknown>;
  resultado: unknown;
  /** Quantas mensagens já existiam quando a chamada aconteceu. */
  posicao: number;
}

/** A dívida e a pessoa de uma conversa. O padrão é o João do teste real da Mia. */
export interface DividaDoAmbiente {
  nome: string;
  credor: string;
  produto: string;
  valorCents: number;
  vencimento: string;
  parcelasVencidas: number;
  cpfPrefixo: string;
  /** Onde a pessoa mora (do cadastro do credor): os contatos de ajuda são os da região. */
  cidade?: string;
  uf?: string;
}

export const DIVIDA_PADRAO: DividaDoAmbiente = {
  nome: "João Carlos",
  credor: "Banco Nova Era",
  produto: "cartão de crédito",
  valorCents: 376_976,
  vencimento: "2026-03-10",
  parcelasVencidas: 7,
  cpfPrefixo: "123",
  cidade: "Campinas",
  uf: "SP",
};

export function criarAmbiente(agora: Date = AGORA_DO_LAB, divida: DividaDoAmbiente = DIVIDA_PADRAO) {
  const estado: EstadoEmMemoria = {
    carteiras: [
      {
        id: "k-lab",
        credor_nome: divida.credor,
        politica: {},
        contato_hora_inicio: 8,
        contato_hora_fim: 20,
        contato_dias: [1, 2, 3, 4, 5, 6],
      },
    ],
    dividas: [
      {
        id: DIVIDA_DO_LAB,
        carteira_id: "k-lab",
        contact_id: CONTATO_DO_LAB,
        produto: divida.produto,
        valor_devido_cents: divida.valorCents,
        vencimento_original: divida.vencimento,
        parcelas_vencidas: divida.parcelasVencidas,
        cpf_prefixo: divida.cpfPrefixo,
        status: "aberta",
        identidade_tentativas: 0,
        identidade_verificada_em: null,
        identidade_bloqueada_ate: null,
        opt_out_em: null,
        retornar_em: null,
        desconto_liberado_pct: null,
        desconto_liberado_job: null,
        devedor_cidade: divida.cidade ?? null,
        devedor_uf: divida.uf ?? null,
        contexto_do_retorno: null,
        cuidado_em: null,
      },
    ],
    acordos: [],
    cobrancas: [],
    tabulacoes: [],
  };
  const ctx: ContextoDeCobranca = {
    repo: repositorioEmMemoria(estado),
    contatoId: CONTATO_DO_LAB,
    agora,
    provedor: new ProvedorFake(),
    sourceJobId: "lab",
  };
  const conversa: Mensagem[] = [];
  const chamadas: Chamada[] = [];
  const handoffs: string[] = [];

  async function executar(nome: string, args: Record<string, unknown>): Promise<unknown> {
    const a = args as never as {
      resposta: string;
      divida_id: string;
      forma: "a_vista" | "parcelado";
      meio?: "pix" | "boleto";
      desfecho: Desfecho;
      motivo?: string;
      retornar_em?: string;
      total_aceito_reais?: number;
      objecao?: Objecao;
      o_que_a_pessoa_disse?: string;
      total_proposto_reais?: number;
      contexto?: string;
      sinal?: string;
    };
    let resultado: unknown;
    switch (nome) {
      case "cobranca_verificar_identidade":
        resultado = await verificarIdentidade(ctx, String(a.resposta ?? ""));
        break;
      case "cobranca_consultar_divida":
        resultado = await consultarDividas(ctx);
        break;
      case "cobranca_simular_acordo":
        resultado = await simularAcordo(ctx, a.divida_id, pedidoDe(a));
        break;
      case "cobranca_pedir_condicao_melhor":
        resultado = await pedirCondicaoMelhor(ctx, a.divida_id, {
          objecao: a.objecao ?? "outro",
          oQueAPessoaDisse: String(a.o_que_a_pessoa_disse ?? ""),
          totalPropostoCents: a.total_proposto_reais === undefined ? undefined : Math.round(a.total_proposto_reais * 100),
        });
        break;
      case "cobranca_fechar_acordo":
        resultado = await fecharAcordo(
          ctx,
          a.divida_id,
          pedidoDe(a),
          a.meio ?? "pix",
          divida.nome,
          a.total_aceito_reais === undefined ? undefined : Math.round(a.total_aceito_reais * 100),
        );
        break;
      case "cobranca_tabular":
        resultado = await tabular(ctx, {
          dividaId: a.divida_id ?? null,
          desfecho: a.desfecho,
          motivo: a.motivo ?? null,
          retornarEm: a.retornar_em ?? null,
          contexto: a.contexto ?? null,
        });
        break;
      case "cobranca_registrar_cuidado":
        resultado = await registrarCuidado(ctx, String(a.sinal ?? ""));
        break;
      case "crm_request_human_handoff":
        handoffs.push(String((args as { reason?: string; motivo?: string }).reason ?? a.motivo ?? ""));
        resultado = { ok: true, mensagem: "um atendente vai assumir a conversa" };
        break;
      default:
        resultado = { erro: `ferramenta desconhecida: ${nome}` };
    }
    chamadas.push({ nome, args, resultado, posicao: conversa.length });
    return resultado;
  }

  /** O estado que o `cobrancaGate` veria neste instante, como o before-send monta. */
  function estadoDoEnvio(resposta: boolean): EstadoDaCobrancaNoEnvio {
    const d = estado.dividas[0]!;
    const faixa = faixaVigente(
      POLITICA_PADRAO,
      diasDeAtraso(
        { id: d.id, credor: "", produto: "", saldoCents: d.valor_devido_cents, vencimentoOriginal: d.vencimento_original },
        hojeLocal(ctx.agora),
      ),
    );
    return {
      identidadeConfirmada: identidadeVigente(d.identidade_verificada_em, ctx.agora),
      optOut: d.opt_out_em !== null,
      cuidado: d.cuidado_em !== null,
      resposta,
      janela: { horaInicio: 8, horaFim: 20, dias: [1, 2, 3, 4, 5, 6], fuso: "America/Sao_Paulo" },
      descontoMaximoPct: faixa.descontoMaximoPct,
      maxParcelas: POLITICA_PADRAO.maxParcelas,
    };
  }

  /**
   * Passa a mensagem da Bella pelo envio de verdade: Markdown vira formatação do
   * WhatsApp e o guardrail confere. Veto devolve o motivo; ok registra o texto
   * que sairia no canal.
   */
  function tentarEnviar(
    textoDoModelo: string,
    vetosAnteriores: string[],
    resposta = true,
  ): { ok: true; texto: string } | { ok: false; code: string; reason: string } {
    const texto = markdownParaWhatsapp(textoDoModelo);
    const veto = avaliarEnvioDeCobranca(texto, estadoDoEnvio(resposta), ctx.agora);
    if (veto) return { ok: false, code: veto.code, reason: veto.reason };
    conversa.push({ autor: "bella", texto, vetos: vetosAnteriores, em: ctx.agora.toISOString() });
    return { ok: true, texto };
  }

  function devedorDiz(texto: string) {
    conversa.push({ autor: "devedor", texto, vetos: [], em: ctx.agora.toISOString() });
  }

  /** O relógio da conversa anda (o simulador pula dias): banco, ferramentas e guardrail passam a ver a nova data. */
  function avancarPara(nova: Date) {
    if (nova.getTime() <= ctx.agora.getTime()) throw new Error("a nova data precisa ser depois da atual");
    ctx.agora = nova;
    conversa.push({ autor: "sistema", texto: `tempo avançado para ${nova.toISOString()}`, vetos: [], em: nova.toISOString() });
  }

  return {
    divida,
    get agora() {
      return ctx.agora;
    },
    estado,
    ctx,
    conversa,
    chamadas,
    handoffs,
    executar,
    tentarEnviar,
    devedorDiz,
    estadoDoEnvio,
    avancarPara,
  };
}

export type Ambiente = ReturnType<typeof criarAmbiente>;
