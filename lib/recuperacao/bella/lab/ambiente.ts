/**
 * O "mundo" de uma conversa de laboratório: banco em memória com a dívida do
 * João (os números do teste real da Mia), as ferramentas da Bella ligadas ao
 * serviço de verdade e o guardrail de envio de verdade. Só o banco e o canal
 * são de mentira.
 */
import { pedidoDe } from "@/lib/mcp/tools/recuperacao";

import { avaliarEnvioDeCobranca, type EstadoDaCobrancaNoEnvio } from "../../guardrail";
import { ProvedorFake } from "../../pagamento/fake";
import { POLITICA_PADRAO, diasDeAtraso, faixaVigente } from "../../politica";
import { repositorioEmMemoria, type EstadoEmMemoria } from "../../repositorio";
import {
  consultarDividas,
  fecharAcordo,
  hojeLocal,
  simularAcordo,
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
  autor: "bella" | "devedor";
  texto: string;
  /** Vetos do guardrail que a Bella levou antes de esta versão sair. */
  vetos: string[];
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
}

export const DIVIDA_PADRAO: DividaDoAmbiente = {
  nome: "João Carlos",
  credor: "Banco Nova Era",
  produto: "cartão de crédito",
  valorCents: 376_976,
  vencimento: "2026-03-10",
  parcelasVencidas: 7,
  cpfPrefixo: "123",
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
      case "cobranca_fechar_acordo":
        resultado = await fecharAcordo(ctx, a.divida_id, pedidoDe(a), a.meio ?? "pix", divida.nome);
        break;
      case "cobranca_tabular":
        resultado = await tabular(ctx, {
          dividaId: a.divida_id ?? null,
          desfecho: a.desfecho,
          motivo: a.motivo ?? null,
          retornarEm: a.retornar_em ?? null,
        });
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
        hojeLocal(agora),
      ),
    );
    return {
      identidadeConfirmada: d.identidade_verificada_em !== null,
      optOut: d.opt_out_em !== null,
      resposta,
      janela: { horaInicio: 8, horaFim: 20, dias: [1, 2, 3, 4, 5, 6], fuso: "America/Sao_Paulo" },
      descontoMaximoPct: faixa.descontoMaximoPct,
      maxParcelas: POLITICA_PADRAO.maxParcelas,
    };
  }

  /** Passa a mensagem da Bella pelo guardrail. Veto devolve o motivo; ok registra a mensagem. */
  function tentarEnviar(texto: string, vetosAnteriores: string[], resposta = true): { ok: true } | { ok: false; code: string; reason: string } {
    const veto = avaliarEnvioDeCobranca(texto, estadoDoEnvio(resposta), agora);
    if (veto) return { ok: false, code: veto.code, reason: veto.reason };
    conversa.push({ autor: "bella", texto, vetos: vetosAnteriores });
    return { ok: true };
  }

  function devedorDiz(texto: string) {
    conversa.push({ autor: "devedor", texto, vetos: [] });
  }

  return { divida, agora, estado, ctx, conversa, chamadas, handoffs, executar, tentarEnviar, devedorDiz, estadoDoEnvio };
}

export type Ambiente = ReturnType<typeof criarAmbiente>;
