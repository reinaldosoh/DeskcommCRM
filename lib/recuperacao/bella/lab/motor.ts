/**
 * Modo COM MODELO do laboratório: a Bella de verdade (playbook + ferramentas)
 * conversa com um devedor — simulado por outro modelo, ou digitado por gente
 * no simulador — e cada mensagem dela passa pelo guardrail de envio: vetada,
 * ela recebe o motivo e reescreve, como no envio real.
 *
 * Modelos no formato `provedor:modelo` (veja `../simulador/modelos.ts`):
 * `BELLA_LAB_MODELO` (a Bella) e `BELLA_LAB_MODELO_PERSONA` (o devedor e o juiz).
 * Sem provedor, vale `anthropic:` (precisa de `ANTHROPIC_API_KEY`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { generateText, stepCountIs, tool, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import { z } from "zod";

import {
  cobrancaConsultarDivida,
  cobrancaFecharAcordo,
  cobrancaSimularAcordo,
  cobrancaTabular,
  cobrancaVerificarIdentidade,
} from "@/lib/mcp/tools/recuperacao";

import { playbookDaBella } from "../definicao";
import { modeloDe, provedorDe } from "../simulador/modelos";
import { criarAmbiente, type Ambiente, type DividaDoAmbiente } from "./ambiente";
import type { Cenario } from "./cenarios";

export const MODELO_PADRAO_BELLA = "anthropic:claude-sonnet-5-5";
export const MODELO_PADRAO_PERSONA = "anthropic:claude-haiku-5-5";

/** Mantido para quem já importava: resolve `provedor:modelo` (ou só o id, Anthropic). */
export const modelo = modeloDe;

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

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/** "terça-feira, 20/10/2026, 12h" no horário de Brasília. */
export function agoraPorExtenso(agora: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(agora)
      .map((x) => [x.type, x.value]),
  );
  const dia = DIAS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "Sun")];
  const min = p.minute === "00" ? "" : p.minute;
  return `${dia}, ${p.day}/${p.month}/${p.year}, ${p.hour}h${min}`;
}

export function sistemaDaBella(nome: string, agora: Date, playbook: string = playbookDaBella()): string {
  const plataforma = readFileSync(path.join(process.cwd(), "lib", "agent-engine", "playbooks", "platform.md"), "utf8");
  return (
    `${plataforma}\n\n${playbook}\n\n## Contexto desta conversa\n\n` +
    `Contato: ${nome}. Hoje é ${agoraPorExtenso(agora)} (horário de Brasília). ` +
    "A dívida e o credor vêm das ferramentas."
  );
}

const MAX_REESCRITAS = 2;
const ABERTURA = "[sistema] Inicie a conversa de cobrança com o contato.";

export interface Uso {
  entrada: number;
  saida: number;
  cache: number;
}

/** O que aconteceu numa vez da Bella falar. */
export interface TurnoDaBella {
  /** A mensagem que saiu; `null` quando ela não conseguiu mandar nada. */
  texto: string | null;
  /** Vetos do guardrail antes de sair (cada um custou uma reescrita). */
  vetos: Array<{ code: string; texto: string }>;
  /** Saiu nada: modelo mudo ou guardrail vetou todas as versões. */
  travou: "muda" | "vetada" | null;
  ms: number;
  uso: Uso;
  erro?: string;
}

export interface OpcoesDaSessao {
  modeloBella?: string;
  modeloPersona?: string;
  divida?: DividaDoAmbiente;
  agora?: Date;
  /** Playbook desta rodada (para testar uma versão sem gravar o arquivo). */
  playbook?: string;
}

type UsoDoModelo = { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } };

/**
 * Uma conversa com a Bella, turno a turno. O histórico guarda as chamadas de
 * ferramenta e seus resultados (como no motor de produção), não só o texto —
 * a Bella do turno seguinte enxerga a escada de ofertas que já consultou.
 */
export class SessaoBella {
  readonly amb: Ambiente;
  readonly modeloBella: string;
  readonly modeloPersona: string;
  readonly uso: Uso = { entrada: 0, saida: 0, cache: 0 };
  private readonly system: string;
  private readonly tools: ToolSet;
  private readonly historico: ModelMessage[] = [{ role: "user", content: ABERTURA }];
  private primeira = true;

  constructor(opcoes: OpcoesDaSessao = {}) {
    this.amb = criarAmbiente(opcoes.agora, opcoes.divida);
    this.modeloBella = opcoes.modeloBella ?? process.env.BELLA_LAB_MODELO ?? MODELO_PADRAO_BELLA;
    this.modeloPersona = opcoes.modeloPersona ?? process.env.BELLA_LAB_MODELO_PERSONA ?? MODELO_PADRAO_PERSONA;
    this.system = sistemaDaBella(this.amb.divida.nome, this.amb.agora, opcoes.playbook);
    this.tools = ferramentasDoLab(this.amb);
  }

  private somar(u: UsoDoModelo, acc?: Uso) {
    for (const alvo of acc ? [this.uso, acc] : [this.uso]) {
      alvo.entrada += u.inputTokens ?? 0;
      alvo.saida += u.outputTokens ?? 0;
      alvo.cache += u.inputTokenDetails?.cacheReadTokens ?? 0;
    }
  }

  private instrucoes(): SystemModelMessage {
    // Anthropic: o playbook é igual em todo turno — cache corta custo e latência.
    return provedorDe(this.modeloBella) === "anthropic"
      ? { role: "system", content: this.system, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
      : { role: "system", content: this.system };
  }

  /** A Bella fala (abre a conversa ou responde ao que o devedor disse por último). */
  async vezDaBella(sinal?: AbortSignal): Promise<TurnoDaBella> {
    const t0 = Date.now();
    const uso: Uso = { entrada: 0, saida: 0, cache: 0 };
    const vetos: TurnoDaBella["vetos"] = [];
    const fim = (texto: string | null, travou: TurnoDaBella["travou"], erro?: string): TurnoDaBella => ({
      texto,
      vetos,
      travou,
      ms: Date.now() - t0,
      uso,
      ...(erro ? { erro } : {}),
    });
    try {
      for (let tentativa = 0; tentativa <= MAX_REESCRITAS; tentativa++) {
        const r = await generateText({
          model: modeloDe(this.modeloBella),
          instructions: this.instrucoes(),
          messages: this.historico,
          tools: this.tools,
          stopWhen: stepCountIs(8),
          abortSignal: sinal,
          maxRetries: 3,
        });
        this.somar(r.totalUsage, uso);
        this.historico.push(...(r.responseMessages as ModelMessage[]));
        const texto = r.text.trim();
        if (!texto) return fim(null, "muda");
        const envio = this.amb.tentarEnviar(texto, vetos.map((v) => v.code), !this.primeira);
        if (envio.ok) {
          this.primeira = false;
          return fim(texto, null);
        }
        vetos.push({ code: envio.code, texto });
        this.historico.push({ role: "user", content: `[sistema] mensagem NÃO enviada: ${envio.reason}` });
      }
      return fim(null, "vetada");
    } catch (e) {
      return fim(null, "muda", e instanceof Error ? e.message : String(e));
    }
  }

  /** O devedor (gente ou persona) fala. */
  devedorDiz(texto: string) {
    this.amb.devedorDiz(texto);
    this.historico.push({ role: "user", content: texto });
  }

  /** A persona simulada escreve a próxima fala do devedor; `null` quando ela encerra. */
  async falaDaPersona(persona: string, cpfQueSabe: string, sinal?: AbortSignal): Promise<string | null> {
    const fala = await generateText({
      model: modeloDe(this.modeloPersona),
      system:
        `${persona}\nOs 3 primeiros dígitos do CPF que você sabe: ${cpfQueSabe}.\n` +
        "Você está numa conversa de WhatsApp com uma empresa de cobrança. Responda como no WhatsApp: curto, " +
        "informal, uma mensagem só, sem aspas e sem narrar ações. Nunca saia do personagem. Quando a conversa " +
        "tiver terminado (você encerrou, ou não há mais nada a dizer), responda exatamente FIM.",
      messages: this.amb.conversa.map((m) => ({
        role: m.autor === "bella" ? ("user" as const) : ("assistant" as const),
        content: m.texto,
      })),
      abortSignal: sinal,
      maxRetries: 3,
    });
    this.somar(fala.totalUsage);
    const texto = fala.text.trim().replace(/^["“]|["”]$/g, "");
    if (!texto || /^FIM\.?$/i.test(texto)) return null;
    return texto.replace(/\s*\bFIM\.?$/, "").trim() || null;
  }
}

export interface OpcoesDoMotor extends OpcoesDaSessao {
  maxTurnos?: number;
}

/** Conversa inteira com a persona do cenário (o modo `--modelo` do laboratório). */
export async function conversarComModelo(cenario: Cenario, opcoes: OpcoesDoMotor = {}) {
  const s = new SessaoBella(opcoes);
  for (let turno = 0; turno < (opcoes.maxTurnos ?? 12); turno++) {
    const vez = await s.vezDaBella();
    if (vez.texto === null || s.amb.handoffs.length > 0) break;
    const fala = await s.falaDaPersona(cenario.persona, cenario.cpfQueAPessoaInforma);
    if (fala === null) break;
    s.devedorDiz(fala);
  }
  return s.amb;
}

/** Juiz por modelo: tom e empatia, que regra fixa não mede. Nota de 1 a 5 por item. */
export async function julgarTom(amb: Ambiente, modeloId?: string) {
  const conversa = amb.conversa.map((m) => `${m.autor === "bella" ? "BELLA" : "DEVEDOR"}: ${m.texto}`).join("\n");
  const r = await generateText({
    model: modeloDe(modeloId ?? process.env.BELLA_LAB_MODELO_PERSONA ?? MODELO_PADRAO_PERSONA),
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
