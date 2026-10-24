/**
 * Acesso a dados da recuperação de crédito, atrás de uma interface pequena.
 *
 * Duas implementações: a do Supabase (service role — TODA query filtra
 * `organization_id`, como no resto de `lib/mcp/tools`) e a em memória, usada
 * pelos testes e pelo laboratório da Bella, que roda sem banco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Desfecho, FormaDePagamento } from "./tipos";

export interface CarteiraRow {
  id: string;
  credor_nome: string;
  politica: Record<string, unknown>;
  contato_hora_inicio: number;
  contato_hora_fim: number;
  contato_dias: number[];
}

export interface DividaRow {
  id: string;
  carteira_id: string;
  contact_id: string | null;
  produto: string;
  valor_devido_cents: number;
  vencimento_original: string;
  parcelas_vencidas: number | null;
  cpf_prefixo: string | null;
  status: "aberta" | "em_acordo" | "quitada" | "cancelada";
  identidade_tentativas: number;
  identidade_verificada_em: string | null;
  identidade_bloqueada_ate: string | null;
  opt_out_em: string | null;
  retornar_em: string | null;
  /** Desconto à vista já liberado nesta negociação (null = o inicial da faixa). */
  desconto_liberado_pct: number | null;
  /** O run que liberou o último degrau: um degrau por vez da pessoa falar. */
  desconto_liberado_job: string | null;
  /** Cidade e UF do devedor (do cadastro do credor): os contatos de ajuda são os da região. */
  devedor_cidade: string | null;
  devedor_uf: string | null;
  /** O que a pessoa contou e importa no retorno ("perdeu o emprego, recebe em janeiro"). */
  contexto_do_retorno: string | null;
  /** Sinal de risco à vida: a cobrança para até um humano liberar. */
  cuidado_em: string | null;
}

export interface NovoAcordo {
  divida_id: string;
  contact_id: string | null;
  forma: FormaDePagamento;
  total_cents: number;
  desconto_pct: number;
  desconto_cents: number;
  parcelas: number;
  entrada_cents: number;
  parcela_cents: number;
  primeiro_vencimento: string;
  meio_pagamento: "pix" | "boleto";
  source_job_id: string | null;
}

export interface NovaCobranca {
  acordo_id: string;
  parcela: number;
  valor_cents: number;
  vencimento: string;
  meio: "pix" | "boleto";
  provedor: string;
  id_externo: string;
  teste: boolean;
  pix_copia_e_cola: string | null;
  boleto_linha_digitavel: string | null;
}

export interface NovaTabulacao {
  divida_id: string | null;
  contact_id: string | null;
  desfecho: Desfecho;
  motivo: string | null;
  source_job_id: string | null;
}

export type AtualizacaoDeDivida = Partial<
  Pick<
    DividaRow,
    | "status"
    | "identidade_tentativas"
    | "identidade_verificada_em"
    | "identidade_bloqueada_ate"
    | "opt_out_em"
    | "retornar_em"
    | "desconto_liberado_pct"
    | "desconto_liberado_job"
    | "contexto_do_retorno"
    | "cuidado_em"
  > & { ultimo_desfecho: Desfecho }
>;

export interface RepositorioDeRecuperacao {
  dividasDoContato(contactId: string): Promise<DividaRow[]>;
  carteira(id: string): Promise<CarteiraRow | null>;
  atualizarDivida(id: string, campos: AtualizacaoDeDivida): Promise<void>;
  acordoAtivo(dividaId: string): Promise<{ id: string } | null>;
  inserirAcordo(acordo: NovoAcordo): Promise<{ id: string }>;
  inserirCobranca(cobranca: NovaCobranca): Promise<void>;
  inserirTabulacao(tabulacao: NovaTabulacao): Promise<void>;
}

function falhou(op: string, error: { message: string }): never {
  throw new Error(`recuperacao_${op}_falhou: ${error.message}`);
}

export function repositorioSupabase(supabase: SupabaseClient, organizationId: string): RepositorioDeRecuperacao {
  return {
    async dividasDoContato(contactId) {
      const { data, error } = await supabase
        .from("recuperacao_dividas")
        .select(
          "id, carteira_id, contact_id, produto, valor_devido_cents, vencimento_original, parcelas_vencidas, " +
            "cpf_prefixo, status, identidade_tentativas, identidade_verificada_em, identidade_bloqueada_ate, " +
            "opt_out_em, retornar_em, desconto_liberado_pct, desconto_liberado_job, devedor_cidade, devedor_uf, " +
            "contexto_do_retorno, cuidado_em",
        )
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("vencimento_original", { ascending: true });
      if (error) falhou("dividas", error);
      return (data ?? []) as unknown as DividaRow[];
    },
    async carteira(id) {
      const { data, error } = await supabase
        .from("recuperacao_carteiras")
        .select("id, credor_nome, politica, contato_hora_inicio, contato_hora_fim, contato_dias")
        .eq("organization_id", organizationId)
        .eq("id", id)
        .maybeSingle();
      if (error) falhou("carteira", error);
      return (data ?? null) as CarteiraRow | null;
    },
    async atualizarDivida(id, campos) {
      const { error } = await supabase
        .from("recuperacao_dividas")
        .update({ ...campos, updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("id", id);
      if (error) falhou("atualizar_divida", error);
    },
    async acordoAtivo(dividaId) {
      const { data, error } = await supabase
        .from("recuperacao_acordos")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("divida_id", dividaId)
        .eq("status", "ativo")
        .maybeSingle();
      if (error) falhou("acordo_ativo", error);
      return (data ?? null) as { id: string } | null;
    },
    async inserirAcordo(acordo) {
      const { data, error } = await supabase
        .from("recuperacao_acordos")
        .insert({ ...acordo, organization_id: organizationId })
        .select("id")
        .single();
      if (error) falhou("inserir_acordo", error);
      return data as { id: string };
    },
    async inserirCobranca(cobranca) {
      const { error } = await supabase
        .from("recuperacao_cobrancas")
        .insert({ ...cobranca, organization_id: organizationId });
      if (error) falhou("inserir_cobranca", error);
    },
    async inserirTabulacao(tabulacao) {
      const { error } = await supabase
        .from("recuperacao_tabulacoes")
        .insert({ ...tabulacao, organization_id: organizationId });
      if (error) falhou("inserir_tabulacao", error);
    },
  };
}

/** Banco de mentira, em memória — para testes e para o laboratório. */
export interface EstadoEmMemoria {
  carteiras: CarteiraRow[];
  dividas: DividaRow[];
  acordos: Array<NovoAcordo & { id: string; status: string }>;
  cobrancas: NovaCobranca[];
  tabulacoes: NovaTabulacao[];
}

export function repositorioEmMemoria(estado: EstadoEmMemoria): RepositorioDeRecuperacao {
  let seq = 0;
  return {
    async dividasDoContato(contactId) {
      return estado.dividas.filter((d) => d.contact_id === contactId).map((d) => ({ ...d }));
    },
    async carteira(id) {
      return estado.carteiras.find((c) => c.id === id) ?? null;
    },
    async atualizarDivida(id, campos) {
      const d = estado.dividas.find((x) => x.id === id);
      if (d) Object.assign(d, campos);
    },
    async acordoAtivo(dividaId) {
      const a = estado.acordos.find((x) => x.divida_id === dividaId && x.status === "ativo");
      return a ? { id: a.id } : null;
    },
    async inserirAcordo(acordo) {
      seq += 1;
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      estado.acordos.push({ ...acordo, id, status: "ativo" });
      return { id };
    },
    async inserirCobranca(cobranca) {
      estado.cobrancas.push(cobranca);
    },
    async inserirTabulacao(tabulacao) {
      estado.tabulacoes.push(tabulacao);
    },
  };
}
