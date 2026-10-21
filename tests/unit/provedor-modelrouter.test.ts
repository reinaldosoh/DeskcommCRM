/**
 * O MODELROUTER É PROVEDOR DE PRIMEIRA CLASSE, e é ROTEADOR.
 *
 * Mesmo molde de `provedor-requesty.test.ts`: gateway OpenAI-compatível de
 * vários fabricantes (modelrouter.id), aceito na escrita, executável no registry
 * e no ensaio, e roteador (a capacidade sai do prefixo do fabricante no id).
 * Diferença: sem catálogo sincronizado — o seletor cai no campo livre.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ehRoteador, modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { ehProvedorSuportado, IDS_DE_PROVEDOR, PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { buildModel } from "@/lib/ai/runtime/agent";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respostaFalsa(status: number, corpo: unknown = {}) {
  return vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => corpo,
      }) as unknown as Response,
  );
}

describe("ModelRouter é aceita na ESCRITA", () => {
  it("está na lista única de que derivam todas as portas de escrita", () => {
    expect(IDS_DE_PROVEDOR).toContain("modelrouter");
    expect(ehProvedorSuportado("modelrouter")).toBe(true);
  });

  it("o schema de versão de agente aceita provider=modelrouter", () => {
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: "modelrouter",
      model: "openai/gpt-4o-mini",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
});

describe("ModelRouter é executável", () => {
  it("declara os campos que a tela precisa", () => {
    const p = PROVEDOR_POR_ID.get("modelrouter");
    expect(p).toBeDefined();
    expect(p!.rotulo.trim().length).toBeGreaterThan(0);
    expect(p!.quandoUsar.trim().length).toBeGreaterThan(20);
    expect(p!.aceitaEndpointProprio).toBe(true);
    expect(p!.catalogoSincronizavel).toBe(false);
    expect(p!.ondePegarAChave).toMatch(/^https:\/\//);
  });

  it("o registry de PRODUÇÃO tem a fábrica, em Chat Completions", () => {
    const fabrica = createDefaultRegistry()["modelrouter"];
    expect(fabrica).toBeTypeOf("function");
    const modelo = fabrica!("k", "openai/gpt-4o-mini") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });

  it("a fábrica honra um endpoint próprio (gateway)", () => {
    const modelo = createDefaultRegistry()["modelrouter"]!(
      "k",
      "openai/gpt-4o-mini",
      "https://gateway.exemplo/v1",
    );
    expect(modelo).toBeDefined();
  });

  it("o runtime de ENSAIO executa modelrouter (buildModel)", () => {
    expect(() => buildModel("modelrouter", "k", "openai/gpt-4o-mini")).not.toThrow();
  });

  it("o validador de chave conhece modelrouter e trata 401 e 403 como chave ruim", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", respostaFalsa(status));
      const r = await validateProviderKey("modelrouter", "");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toBe("auth_failed_401");
    }
  });

  it("o validador devolve os modelos que a chave enxerga", async () => {
    vi.stubGlobal("fetch", respostaFalsa(200, { data: [{ id: "openai/gpt-4o-mini" }] }));
    const r = await validateProviderKey("modelrouter", "k");
    expect(r).toEqual({ ok: true, models: ["openai/gpt-4o-mini"] });
  });
});

describe("ModelRouter é ROTEADOR", () => {
  it("a capacidade sai do fabricante no prefixo do id", () => {
    expect(ehRoteador("modelrouter")).toBe(true);
    expect(modelCapabilities("modelrouter", "openai/gpt-4o-mini")).toEqual(
      modelCapabilities("openai", "gpt-4o-mini"),
    );
  });
});

describe("ModelRouter chama o endpoint dele", () => {
  it("o validador consulta modelrouter.id/v1/models com Bearer", async () => {
    const f = respostaFalsa(200, { data: [] });
    vi.stubGlobal("fetch", f);
    await validateProviderKey("modelrouter", "minha-chave");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://modelrouter.id/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer minha-chave");
  });
});
