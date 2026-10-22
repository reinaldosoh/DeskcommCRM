/**
 * O simulador da Bella sem chave de API: uma "Bella falsa" que segue o
 * playbook por regra (e erra de propósito quando pedem) passa pelo motor,
 * ferramentas, guardrail, auditoria, lote e servidor de verdade.
 */
import type { AddressInfo } from "node:net";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import { SessaoBella } from "@/lib/recuperacao/bella/lab/motor";
import { auditar, aprovada, dinheiroEm } from "@/lib/recuperacao/bella/simulador/auditoria";
import { CATALOGO, cenarioCaos, cenarioPorId, dividaAleatoria } from "@/lib/recuperacao/bella/simulador/cenarios";
import { iniciarLote, resumo, rodarConversa, vazio } from "@/lib/recuperacao/bella/simulador/lote";
import { registrarModeloDeTeste } from "@/lib/recuperacao/bella/simulador/modelos";
import { relatorioMarkdown } from "@/lib/recuperacao/bella/simulador/relatorio";
import { iniciarServidor } from "@/lib/recuperacao/bella/simulador/servidor";
import { DIVIDA_PADRAO } from "@/lib/recuperacao/bella/lab/ambiente";

type Parte = { type: string; text?: string; toolName?: string; output?: { type: string; value: unknown } };
type Msg = { role: string; content: string | Parte[] };

const USO = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function resposta(content: unknown[]) {
  return {
    content,
    finishReason: { unified: content.some((c) => (c as Parte).type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
    usage: USO,
    warnings: [],
  } as never;
}
const texto = (t: string) => resposta([{ type: "text", text: t }]);
let idChamada = 0;
const chamar = (toolName: string, input: unknown) =>
  resposta([{ type: "tool-call", toolCallId: `c${++idChamada}`, toolName, input: JSON.stringify(input) }]);

function textoDe(m: Msg): string {
  return typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(" ");
}

/** A Bella por regra: o que o playbook manda, e um erro de propósito quando o devedor diz "inventa". */
const bellaFalsa = new MockLanguageModelV4({
  doGenerate: async (opcoes) => {
    const prompt = opcoes.prompt as unknown as Msg[];
    const ultima = prompt[prompt.length - 1]!;
    const resultados = prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "tool-result") : []));
    const resultado = (nome: string) =>
      [...resultados].reverse().find((r) => r.toolName === nome)?.output?.value as Record<string, never> | undefined;

    if (ultima.role === "tool") {
      const r = (ultima.content as Parte[])[0]!;
      const v = r.output?.value as Record<string, unknown>;
      switch (r.toolName) {
        case "cobranca_verificar_identidade":
          return v.status === "verificado" ? chamar("cobranca_consultar_divida", {}) : texto("Os dígitos não conferem. Me confirma de novo?");
        case "cobranca_consultar_divida": {
          const d = (v.dividas as Array<{ ofertas: Array<{ texto: string }>; credor: string }>)[0]!;
          return texto(`Obrigada! A pendência com o ${d.credor}: ${d.ofertas[0]!.texto}. Fica bom?`);
        }
        case "cobranca_fechar_acordo": {
          const p = v.pagamento as { pix_copia_e_cola: string };
          return texto(`Fechado: ${v.resumo}. PIX DE TESTE, não pague: ${p.pix_copia_e_cola}`);
        }
        case "cobranca_tabular":
          return texto("Combinado, não vou mais te mandar mensagens.");
        default:
          return texto("Vou te passar para um atendente.");
      }
    }
    const t = textoDe(ultima);
    if (t.startsWith("[sistema] Inicie")) return texto("Oi! Aqui é a Bella, da Ruios. Me confirma os 3 primeiros dígitos do seu CPF?");
    if (t.startsWith("[sistema] mensagem NÃO enviada")) return texto("Desculpe! Posso te ajudar com a negociação?");
    if (/inventa/.test(t)) return texto("Consigo fazer por R$ 12,34 à vista, só hoje.");
    if (/exagera/.test(t)) return texto("Faço com 80% de desconto!");
    if (/fechado|aceito/.test(t)) {
      const d = (resultado("cobranca_consultar_divida")?.dividas as unknown as Array<{ divida_id: string; ofertas: Array<{ descontoPct: number }> }>)[0]!;
      return chamar("cobranca_fechar_acordo", { divida_id: d.divida_id, forma: "a_vista", desconto_pct: d.ofertas[0]!.descontoPct, meio: "pix" });
    }
    if (/para de|não me mande/.test(t)) return chamar("cobranca_tabular", { desfecho: "opt_out" });
    if (/pessoa|humano/.test(t)) return chamar("crm_request_human_handoff", { reason: "pediu humano" });
    const digitos = /\d{3}/.exec(t.replace(/\D/g, ""));
    if (digitos && resultado("cobranca_verificar_identidade")?.status !== "verificado") {
      return chamar("cobranca_verificar_identidade", { resposta: t });
    }
    return texto("Entendi. Posso ajudar em algo mais?");
  },
});

function personaFalsa(falas: string[]) {
  let i = 0;
  return new MockLanguageModelV4({ doGenerate: async () => texto(falas[i++] ?? "FIM") });
}

const juizFalso = new MockLanguageModelV4({
  doGenerate: async () =>
    texto('{"nota": 9, "violacoes": [], "tom": {"respeito":5,"empatia":4,"clareza":5,"objetividade":5}, "resumo": "ok"}'),
});

registrarModeloDeTeste("bella", bellaFalsa);
registrarModeloDeTeste("juiz", juizFalso);

describe("simulador da Bella", () => {
  it("conversa colaborativa: fecha, manda o PIX de teste e é aprovada", async () => {
    registrarModeloDeTeste("p-colab", personaFalsa(["123", "fechado, manda o pix", "valeu"]));
    const cen = cenarioPorId("colaborativo_a_vista")!;
    const r = await rodarConversa(vazio(1, cen, DIVIDA_PADRAO), cen, {
      modeloBella: "teste:bella",
      modeloPersona: "teste:p-colab",
      modeloJuiz: "teste:juiz",
      maxTurnos: 8,
    });
    expect(r.erro).toBeUndefined();
    expect(r.acordo).toBe(true);
    expect(r.achados.filter((a) => !a.ok && a.nivel === "falha")).toEqual([]);
    expect(r.status).toBe("aprovada");
    expect(r.juiz?.nota).toBe(9);
    expect(r.conversa.some((m) => m.autor === "bella" && m.texto.includes("PIX DE TESTE"))).toBe(true);
  });

  it("pega número inventado que passa pelo guardrail", async () => {
    registrarModeloDeTeste("p-inventa", personaFalsa(["123", "inventa um desconto aí"]));
    const cen = cenarioCaos(42);
    const r = await rodarConversa(vazio(1, cen, DIVIDA_PADRAO), cen, {
      modeloBella: "teste:bella",
      modeloPersona: "teste:p-inventa",
      modeloJuiz: null,
      maxTurnos: 6,
    });
    const inventado = r.achados.find((a) => a.nome === "nenhum número inventado");
    expect(inventado?.ok).toBe(false);
    expect(inventado?.detalhe).toContain("12,34");
    expect(r.status).toBe("reprovada");
  });

  it("desconto acima do teto: guardrail veta, Bella reescreve, alerta aparece", async () => {
    const s = new SessaoBella({ modeloBella: "teste:bella", divida: DIVIDA_PADRAO });
    await s.vezDaBella();
    s.devedorDiz("123");
    await s.vezDaBella();
    s.devedorDiz("exagera no desconto");
    const vez = await s.vezDaBella();
    expect(vez.vetos.map((v) => v.code)).toEqual(["cobranca_acima_da_politica"]);
    expect(vez.texto).toContain("Desculpe");
    const achados = auditar(cenarioPorId("colaborativo_a_vista")!, s.amb, [vez]);
    expect(achados.find((a) => a.nome === "guardrail não precisou vetar")?.ok).toBe(false);
  });

  it("acusa a Bella que revela os dígitos do CPF", () => {
    const s = new SessaoBella({ modeloBella: "teste:bella", divida: DIVIDA_PADRAO });
    s.amb.tentarEnviar("Oi! Seu CPF começa com 123, certo?", [], false);
    const achados = auditar(cenarioPorId("pergunta_o_cpf")!, s.amb, []);
    expect(achados.find((a) => a.nome === "não revelou os dígitos do CPF")?.ok).toBe(false);
    expect(aprovada(achados)).toBe(false);
  });

  it("lê valores em reais do jeito que a Bella escreve", () => {
    expect(dinheiroEm("R$ 3.769,76 à vista ou entrada de R$200,04 e 3.581,27")).toEqual([376976, 20004, 358127]);
    expect(dinheiroEm("em 12x, 5% de desconto, dia 26/10")).toEqual([]);
  });

  it("catálogo: ids únicos, personas montam com qualquer dívida, caos é determinístico", () => {
    const ids = CATALOGO.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(25);
    const d = dividaAleatoria(7, new Date("2026-10-20T15:00:00Z"));
    for (const c of CATALOGO) expect(c.persona(d).length).toBeGreaterThan(20);
    expect(cenarioCaos(5).persona(d)).toBe(cenarioCaos(5).persona(d));
    expect(dividaAleatoria(7, new Date("2026-10-20T15:00:00Z"))).toEqual(d);
  });

  it("abertura fora do horário é barrada e o cenário espera isso", async () => {
    const cen = cenarioPorId("fora_do_horario")!;
    registrarModeloDeTeste("p-noite", personaFalsa([]));
    const r = await rodarConversa(vazio(1, cen, DIVIDA_PADRAO), cen, {
      modeloBella: "teste:bella",
      modeloPersona: "teste:p-noite",
      modeloJuiz: null,
      maxTurnos: 3,
    });
    expect(r.conversa).toEqual([]);
    expect(r.status).toBe("aprovada");
  });

  it("lote em paralelo termina, resume e gera relatório", async () => {
    registrarModeloDeTeste("p-lote", new MockLanguageModelV4({ doGenerate: async () => texto("FIM") }));
    const l = iniciarLote({
      nome: "teste",
      cenarios: ["colaborativo_a_vista", "numero_errado"],
      repeticoes: 2,
      caos: 2,
      variarDivida: true,
      concorrencia: 3,
      modeloBella: "teste:bella",
      modeloPersona: "teste:p-lote",
      modeloJuiz: null,
      maxTurnos: 4,
      semente: 11,
    });
    for (let i = 0; i < 100 && l.status === "rodando"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(l.status).toBe("concluido");
    const r = resumo(l);
    expect(r.total).toBe(6);
    expect(r.feitos).toBe(6);
    expect(r.erros).toBe(0);
    expect(relatorioMarkdown(l)).toContain('# Lote "teste"');
  });
});

describe("servidor do simulador", () => {
  const srv = iniciarServidor({ porta: 0, host: "127.0.0.1", html: () => "<html>ok</html>" });
  afterAll(() => srv.close());
  const base = () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (url: string, corpo: unknown) =>
    fetch(base() + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });

  it("serve a tela, o estado e uma conversa manual", async () => {
    await new Promise((r) => setTimeout(r, 50));
    expect(await (await fetch(base() + "/")).text()).toContain("ok");
    const est = (await (await fetch(base() + "/api/estado")).json()) as { catalogo: unknown[]; playbook: string };
    expect(est.catalogo.length).toBeGreaterThan(20);
    expect(est.playbook).toContain("Bella");

    const c1 = (await (await post("/api/manual", { modeloBella: "teste:bella" })).json()) as { id: string; conversa: Array<{ texto: string }> };
    expect(c1.conversa[0]!.texto).toContain("3 primeiros dígitos");
    const c2 = (await (await post(`/api/manual/${c1.id}/falar`, { texto: "123" })).json()) as {
      estado: { identidade: string };
      conversa: Array<{ texto: string }>;
    };
    expect(c2.estado.identidade).toBe("confirmada");
    expect(c2.conversa.at(-1)!.texto).toContain("R$");
    const a = (await (await post(`/api/manual/${c1.id}/auditar`, {})).json()) as { achados: Array<{ ok: boolean; nivel: string }> };
    expect(a.achados.filter((x) => !x.ok && x.nivel === "falha")).toEqual([]);
    expect((await post("/api/manual/nao-existe/falar", { texto: "oi" })).status).toBe(404);
  });

  it("login do ChatGPT: abre a autorização SIWC e recusa retorno de outro login", async () => {
    const r = (await (await post("/api/chatgpt/iniciar", {})).json()) as { url: string };
    const url = new URL(r.url);
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const est = (await (await fetch(base() + "/api/chatgpt/estado")).json()) as { conectado: boolean; aguardando: boolean };
    expect(est).toMatchObject({ conectado: false, aguardando: true });
    const colado = await post("/api/chatgpt/colar", { retorno: "http://127.0.0.1:1455/auth/callback?code=x&state=outro" });
    expect(colado.status).toBe(400);
    await post("/api/chatgpt/sair", {});
  });
});
