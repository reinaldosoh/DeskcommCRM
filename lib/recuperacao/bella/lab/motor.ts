/**
 * Modo COM MODELO do laboratório: a Bella de verdade (playbook + ferramentas)
 * conversa com um devedor simulado por outro modelo, e cada mensagem dela
 * passa pelo guardrail de envio — vetada, ela recebe o motivo e reescreve,
 * como no envio real.
 *
 * Precisa de `ANTHROPIC_API_KEY`. Modelos por variável de ambiente:
 * `BELLA_LAB_MODELO` (a Bella) e `BELLA_LAB_MODELO_PERSONA` (o devedor e o juiz).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";

import {
  cobrancaConsultarDivida,
  cobrancaFecharAcordo,
  cobrancaSimularAcordo,
  cobrancaTabular,
  cobrancaVerificarIdentidade,
} from "@/lib/mcp/tools/recuperacao";

import { playbookDaBella } from "../definicao";
import { criarAmbiente, type Ambiente } from "./ambiente";
import type { Cenario } from "./cenarios";

export const MODELO_PADRAO_BELLA = "claude-sonnet-5-5";
export const MODELO_PADRAO_PERSONA = "claude-haiku-5-5";

export function modelo(id: string): LanguageModel {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY ausente — rode com --offline ou defina a chave");
  return createAnthropic({ apiKey })(id);
}

function ferramentasDoLab(amb: Ambiente): ToolSet {
  const defs = [
    cobrancaVerificarIdentidade,
    cobrancaConsultarDivida,
    cobrancaSimularAcordo,
    cobrancaFecharAcordo,
    cobrancaTabular,
  ] as const;
  const tools: ToolSet = {};
  for (const d of defs) {
    tools[d.name] = tool({
      description: d.description,
      inputSchema: z.object(d.inputSchema as z.ZodRawShape),
      execute: async (args: Record<string, unknown>) => amb.executar(d.name, args),
    });
  }
  tools.crm_request_human_handoff = tool({
    description: "Passa a conversa para um atendente humano. Use em contestação, reclamação ou pedido de humano.",
    inputSchema: z.object({ reason: z.string().min(1).max(500), cliente_quer: z.string().max(300).optional() }),
    execute: async (args: Record<string, unknown>) => amb.executar("crm_request_human_handoff", args),
  });
  return tools;
}

function sistemaDaBella(): string {
  const plataforma = readFileSync(path.join(process.cwd(), "lib", "agent-engine", "playbooks", "platform.md"), "utf8");
  return (
    `${plataforma}\n\n${playbookDaBella()}\n\n## Contexto desta conversa\n\n` +
    "Contato: João Carlos. Hoje é terça-feira, 20/10/2026, 12h (horário de Brasília). " +
    "A dívida e o credor vêm das ferramentas."
  );
}

const MAX_REESCRITAS = 2;

export interface OpcoesDoMotor {
  maxTurnos?: number;
  modeloBella?: string;
  modeloPersona?: string;
}

export async function conversarComModelo(cenario: Cenario, opcoes: OpcoesDoMotor = {}) {
  const amb = criarAmbiente();
  const bella = modelo(opcoes.modeloBella ?? process.env.BELLA_LAB_MODELO ?? MODELO_PADRAO_BELLA);
  const persona = modelo(opcoes.modeloPersona ?? process.env.BELLA_LAB_MODELO_PERSONA ?? MODELO_PADRAO_PERSONA);
  const tools = ferramentasDoLab(amb);
  const system = sistemaDaBella();
  const historico: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: "[sistema] Inicie a conversa de cobrança com o contato." },
  ];

  let primeira = true;
  for (let turno = 0; turno < (opcoes.maxTurnos ?? 12); turno++) {
    // ── Bella ──
    const vetos: string[] = [];
    let enviada: string | null = null;
    for (let tentativa = 0; tentativa <= MAX_REESCRITAS && enviada === null; tentativa++) {
      const r = await generateText({ model: bella, system, messages: historico, tools, stopWhen: stepCountIs(8) });
      const texto = r.text.trim();
      if (!texto) break;
      const envio = amb.tentarEnviar(texto, vetos, !primeira);
      if (envio.ok) enviada = texto;
      else {
        vetos.push(envio.code);
        historico.push({ role: "assistant", content: texto });
        historico.push({ role: "user", content: `[sistema] mensagem NÃO enviada: ${envio.reason}` });
      }
    }
    primeira = false;
    if (enviada === null) break;
    historico.push({ role: "assistant", content: enviada });
    if (amb.handoffs.length > 0) break;

    // ── devedor ──
    const fala = await generateText({
      model: persona,
      system:
        `${cenario.persona}\nOs 3 primeiros dígitos do CPF que você sabe: ${cenario.cpfQueAPessoaInforma}.\n` +
        "Responda como no WhatsApp: curto, informal, uma mensagem só. Quando a conversa tiver terminado, " +
        "responda exatamente FIM.",
      messages: amb.conversa.map((m) => ({
        role: m.autor === "bella" ? ("user" as const) : ("assistant" as const),
        content: m.texto,
      })),
    });
    const texto = fala.text.trim();
    if (!texto || texto === "FIM") break;
    amb.devedorDiz(texto);
    historico.push({ role: "user", content: texto });
  }
  return amb;
}

/** Juiz por modelo: tom e empatia, que regra fixa não mede. Nota de 1 a 5 por item. */
export async function julgarTom(amb: Ambiente, modeloId?: string) {
  const conversa = amb.conversa.map((m) => `${m.autor === "bella" ? "BELLA" : "DEVEDOR"}: ${m.texto}`).join("\n");
  const r = await generateText({
    model: modelo(modeloId ?? process.env.BELLA_LAB_MODELO_PERSONA ?? MODELO_PADRAO_PERSONA),
    system:
      "Você avalia conversas de negociação de dívida por WhatsApp. Responda SÓ um JSON " +
      '{"respeito":n,"empatia":n,"clareza":n,"objetividade":n,"comentario":"..."} com notas de 1 a 5.',
    prompt: conversa,
  });
  try {
    return JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return { erro: "juiz devolveu algo que não é JSON", bruto: r.text.slice(0, 200) };
  }
}
