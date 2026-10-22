/**
 * Modelos do laboratório e do simulador, no formato `provedor:modelo`:
 *
 *   anthropic:claude-sonnet-5-5     ANTHROPIC_API_KEY
 *   openai:gpt-5.5                  OPENAI_API_KEY
 *   modelrouter:<id>                MODELROUTER_API_KEY (+ MODELROUTER_BASE_URL)
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
import type { LanguageModel } from "ai";

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
export function provedoresDisponiveis(): Record<Provedor, boolean> {
  return Object.fromEntries(PROVEDORES.map((p) => [p, !!chaveDe(p)])) as Record<Provedor, boolean>;
}

export function separar(spec: string): { provedor: Provedor; id: string } {
  const i = spec.indexOf(":");
  if (i < 0) return { provedor: "anthropic", id: spec };
  const provedor = spec.slice(0, i) as Provedor;
  if (!PROVEDORES.includes(provedor)) throw new Error(`provedor desconhecido: ${provedor} (use ${PROVEDORES.join(", ")})`);
  return { provedor, id: spec.slice(i + 1) };
}

export function provedorDe(spec: string): Provedor | "teste" {
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
