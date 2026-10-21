/**
 * A Bella como AGENTE: o playbook (instruções) e as ferramentas que ela usa.
 * É daqui que o laboratório e a criação do agente na organização leem — uma
 * fonte só, para o que se testa ser o que vai ao ar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const NOME_DA_AGENTE = "Bella";

export const PLAYBOOK_DA_BELLA_PATH = path.join(process.cwd(), "lib", "recuperacao", "bella", "playbook.md");

export function playbookDaBella(): string {
  return readFileSync(PLAYBOOK_DA_BELLA_PATH, "utf8");
}

/** As ferramentas da Bella: as cinco de cobrança e a passagem para humano. */
export const FERRAMENTAS_DA_BELLA = [
  "cobranca_verificar_identidade",
  "cobranca_consultar_divida",
  "cobranca_simular_acordo",
  "cobranca_fechar_acordo",
  "cobranca_tabular",
  "crm_request_human_handoff",
] as const;

/**
 * O rascunho da Bella no formato de `agentMcpCreateSchema` — o mesmo que a tela
 * e a API usam para criar agente (`createMcpAgentDraft`). Sai como RASCUNHO:
 * publicar e ligar a um número continua sendo ato de quem opera.
 */
export function rascunhoDaBella(opcoes: {
  provider?: string;
  model?: string;
  channelSessionId?: string | null;
} = {}) {
  return {
    name: NOME_DA_AGENTE,
    description: "Agente de negociação de dívidas da Pacare: confirma identidade, negocia dentro da política e envia o pagamento na hora.",
    version: {
      system_prompt: playbookDaBella(),
      provider: opcoes.provider ?? "anthropic",
      model: opcoes.model ?? "claude-sonnet-5-5",
      credential_id: null,
      channel_session_id: opcoes.channelSessionId ?? null,
      tool_ids: [...FERRAMENTAS_DA_BELLA],
      handoff_keywords: ["falar com humano", "atendente", "pessoa real", "advogado", "procon"],
      // Uma ideia por mensagem, como no WhatsApp; o código do PIX vai inteiro.
      split_messages: false,
    },
  };
}
