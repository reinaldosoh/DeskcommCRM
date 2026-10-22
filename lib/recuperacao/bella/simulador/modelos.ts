/**
 * Modelos do laboratório e do simulador, no formato `provedor:modelo`:
 *
 *   anthropic:claude-sonnet-5-5     ANTHROPIC_API_KEY
 *   openai:gpt-5.5                  OPENAI_API_KEY
 *   modelrouter:<id>                MODELROUTER_API_KEY (+ MODELROUTER_BASE_URL)
 *   chatgpt:<id>                    login com a assinatura do ChatGPT (`chatgpt.ts`)
 *
 * Sem prefixo, é Anthropic (compatível com o `BELLA_LAB_MODELO` antigo). A
 * chave pode vir do ambiente ou ser colada na tela do simulador — fica só na
 * memória do processo (ou no arquivo local que a pessoa pedir para lembrar).
 *
 * ModelRouter: o simulador só usa dados fictícios, então serve para rodar
 * lotes baratos; dado de devedor real continua indo só por API direta.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, type LanguageModel } from "ai";

import { estadoDoLogin, tokenDaAssinatura } from "./chatgpt";

/**
 * O mesmo endpoint de `OPENAI_CODEX_ENDPOINT` (agent-engine/edge/llm/providers),
 * repetido aqui de propósito: importar aquele módulo arrasta a validação de
 * ambiente do app (Supabase etc.) e o simulador roda sem nada disso.
 */
const ENDPOINT_DA_ASSINATURA = "https://api.openai.com/v1";

/** Provedores por CHAVE de API (o ChatGPT entra por login, à parte). */
export const PROVEDORES = ["anthropic", "openai", "modelrouter"] as const;
export type Provedor = (typeof PROVEDORES)[number];

const VARIAVEL: Record<Provedor, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  modelrouter: "MODELROUTER_API_KEY",
};

const chavesColadas: Partial<Record<Provedor, string>> = {};

export function definirChave(provedor: Provedor, chave: string | null) {
  if (chave) chavesColadas[provedor] = chave.trim();
  else delete chavesColadas[provedor];
}

function chaveDe(provedor: Provedor): string | undefined {
  return chavesColadas[provedor] ?? process.env[VARIAVEL[provedor]] ?? undefined;
}

/** Quais provedores têm chave agora (para a tela mostrar o que dá para usar). */
export function provedoresDisponiveis(): Record<Provedor | "chatgpt", boolean> {
  return {
    ...(Object.fromEntries(PROVEDORES.map((p) => [p, !!chaveDe(p)])) as Record<Provedor, boolean>),
    chatgpt: estadoDoLogin().conectado,
  };
}

export function separar(spec: string): { provedor: Provedor | "chatgpt"; id: string } {
  const i = spec.indexOf(":");
  if (i < 0) return { provedor: "anthropic", id: spec };
  const provedor = spec.slice(0, i) as Provedor | "chatgpt";
  if (provedor !== "chatgpt" && !PROVEDORES.includes(provedor)) {
    throw new Error(`provedor desconhecido: ${provedor} (use ${PROVEDORES.join(", ")} ou chatgpt)`);
  }
  return { provedor, id: spec.slice(i + 1) };
}

export function provedorDe(spec: string): Provedor | "chatgpt" | "teste" {
  return spec.startsWith("teste:") ? "teste" : separar(spec).provedor;
}

/** Fábricas de teste (modelos falsos): `teste:<nome>` resolve aqui antes dos provedores reais. */
const modelosDeTeste = new Map<string, LanguageModel>();
export function registrarModeloDeTeste(nome: string, m: LanguageModel) {
  modelosDeTeste.set(nome, m);
}

export function modeloDe(spec: string): LanguageModel {
  if (spec.startsWith("teste:")) {
    const m = modelosDeTeste.get(spec.slice(6));
    if (!m) throw new Error(`modelo de teste não registrado: ${spec}`);
    return m;
  }
  const { provedor, id } = separar(spec);
  if (provedor === "chatgpt") throw new Error("chatgpt: use gerar(), que renova o login antes de chamar");
  const apiKey = chaveDe(provedor);
  if (!apiKey) throw new Error(`sem chave para ${provedor}: defina ${VARIAVEL[provedor]} ou cole a chave no simulador`);
  switch (provedor) {
    case "anthropic":
      return createAnthropic({ apiKey })(id);
    case "openai":
      return createOpenAI({ apiKey })(id);
    case "modelrouter":
      return createOpenAI({ apiKey, baseURL: process.env.MODELROUTER_BASE_URL ?? "https://modelrouter.id/v1" }).chat(id);
  }
}

type OpcoesDeGerar = Omit<Parameters<typeof generateText>[0], "model">;

/**
 * Uma chamada de modelo pelo `spec`. Igual a `generateText` para quem tem
 * chave; pela assinatura do ChatGPT vai em streaming com `store:false` e sem
 * opções de amostragem (o contrato do SIWC, o mesmo de `runModelCall`).
 */
export async function gerar(spec: string, opcoes: OpcoesDeGerar) {
  if (provedorDe(spec) !== "chatgpt") {
    const r = await generateText({ ...opcoes, model: modeloDe(spec) } as Parameters<typeof generateText>[0]);
    return { text: r.text, totalUsage: r.totalUsage, responseMessages: r.responseMessages };
  }
  const apiKey = await tokenDaAssinatura();
  const model = createOpenAI({ apiKey, baseURL: ENDPOINT_DA_ASSINATURA })(separar(spec).id);
  let erroDoStream: unknown = null;
  const r = streamText({
    ...(opcoes as Parameters<typeof streamText>[0]),
    model,
    providerOptions: { openai: { store: false } },
    onError: ({ error }) => {
      erroDoStream = error;
    },
  });
  try {
    const [text, totalUsage, responseMessages] = await Promise.all([r.text, r.totalUsage, r.responseMessages]);
    return { text, totalUsage, responseMessages };
  } catch (e) {
    throw erroDoStream ?? e;
  }
}
