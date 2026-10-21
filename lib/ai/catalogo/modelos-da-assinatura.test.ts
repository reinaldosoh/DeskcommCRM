import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LISTAGEM DE MODELOS DA ASSINATURA FALA COM O BACKEND DO CODEX (#2602).
 *
 * MEDIDO na issue com o token do Sign in with ChatGPT: `GET
 * https://api.openai.com/v1/models` → 403 "Missing scopes: api.model.read";
 * `GET https://chatgpt.com/backend-api/codex/models` → 200 com 10 modelos no
 * formato `{ models: [{ slug, visibility: "list" }] }`. Com o destino antigo a
 * listagem caía no 403, `models_available` ficava `null` para sempre e todo
 * "Publicar" respondia `model_not_found` (a `fn_publish_ai_agent_version`
 * 0592 confere o modelo nessa lista).
 *
 * O QUE ESTE ARQUIVO PROVA (sem token real — a ponta com conta ChatGPT não foi
 * medida, ver o "O que NÃO medi" do PR):
 *   (a) a chamada SAI para o endpoint do Codex e a resposta 200 no formato da
 *       issue grava a lista no espelho `models_available`;
 *   (b) o 403 medido da API pública NÃO silencia: vira
 *       `FalhaAoListarModelosDaAssinatura` (motivo `http_403`) e o espelho
 *       não é tocado;
 *   (c) um 200 em formato que não conhecemos não grava lixo — e também não
 *       engole o problema em `[]`.
 *
 * Sabotagem que confirma: apontar `OPENAI_CODEX_MODELS_ENDPOINT` de volta para
 * `https://api.openai.com/v1/models` deixa o caso (a) vermelho.
 */

const update = vi.hoisted(() => vi.fn());
const semConta = vi.hoisted(() => vi.fn((): { access_token: string } | null => ({ access_token: "at" })));

vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: vi.fn(async () => semConta()),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) cadeia[m] = () => cadeia;
      cadeia.maybeSingle = async () => ({ data: { id: "cred-1" }, error: null });
      cadeia.update = (valores: unknown) => {
        update(valores);
        const filtro: Record<string, unknown> = {};
        filtro.eq = () => filtro;
        return filtro;
      };
      return cadeia;
    },
  }),
}));

import {
  FalhaAoListarModelosDaAssinatura,
  listarModelosDaAssinatura,
  listarModelosDaAssinaturaOuVazio,
} from "./modelos-da-assinatura";

/** O destino da doc do Sign in with ChatGPT para apps: a API pública. */
const ENDPOINT_OFICIAL = "https://api.openai.com/v1/models";
/** A segunda tentativa, para o token antigo da #2602. */
const ENDPOINT_DO_CODEX = "https://chatgpt.com/backend-api/codex/models";

function stubDeFetch(resposta: () => Promise<Response>) {
  const chamada = vi.fn(resposta);
  vi.stubGlobal("fetch", chamada);
  return chamada;
}

function respondeCom(corpo: unknown, status = 200) {
  return stubDeFetch(async () => new Response(JSON.stringify(corpo), { status }));
}

beforeEach(() => {
  update.mockClear();
  semConta.mockImplementation(() => ({ access_token: "at" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("listarModelosDaAssinatura", () => {
  it("(a) fala com a API pública e regrava o espelho com a lista", async () => {
    const chamada = respondeCom({
      models: [
        { slug: "gpt-a", visibility: "list" },
        { slug: "gpt-oculto", visibility: "hide" },
      ],
    });

    const modelos = await listarModelosDaAssinatura("org-1");

    expect(chamada).toHaveBeenCalledTimes(1);
    const [url, init] = chamada.mock.calls[0] as unknown as [string, RequestInit];
    expect(url, "a listagem foi para o endpoint errado").toBe(ENDPOINT_OFICIAL);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer at");
    expect(modelos?.map((m) => m.model_id)).toEqual(["gpt-a"]);
    expect(update).toHaveBeenCalledWith({ models_available: ["gpt-a"] });
  });

  it("(b) o 403 medido da API pública não silencia: erro visível, espelho intacto", async () => {
    // O corpo EXATO medido na issue, vindo do endpoint ERRADO: é o estado que
    // o operador vivia em silêncio enquanto `models_available` ficava null.
    respondeCom(
      {
        message:
          "You have insufficient permissions for this operation. Missing scopes: api.model.read.",
        type: "invalid_request_error",
        code: "insufficient_permissions",
      },
      403,
    );

    const falha = await listarModelosDaAssinatura("org-1").then(
      () => null,
      (erro: unknown) => erro,
    );

    expect(falha).toBeInstanceOf(FalhaAoListarModelosDaAssinatura);
    expect((falha as FalhaAoListarModelosDaAssinatura).motivo).toBe("http_403");
    expect((falha as FalhaAoListarModelosDaAssinatura).status).toBe(403);
    expect(update, "uma falha não pode tocar no espelho").not.toHaveBeenCalled();
  });

  it("(a2) a API pública recusa o token (401) e o backend do Codex atende: lista vem de lá", async () => {
    const chamada = stubDeFetch(async () => new Response("{}", { status: 401 }));
    chamada.mockImplementationOnce(async () => new Response("{}", { status: 401 }));
    chamada.mockImplementationOnce(
      async () => new Response(JSON.stringify({ models: [{ slug: "gpt-b", visibility: "list" }] }), { status: 200 }),
    );

    const modelos = await listarModelosDaAssinatura("org-1");

    const urls = chamada.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([ENDPOINT_OFICIAL, ENDPOINT_DO_CODEX]);
    expect(modelos?.map((m) => m.model_id)).toEqual(["gpt-b"]);
  });

  it("(c) 200 em formato desconhecido não grava lixo — e não engole o problema", async () => {
    respondeCom({ data: [{ id: "gpt-x" }] });

    const falha = await listarModelosDaAssinatura("org-1").then(
      () => null,
      (erro: unknown) => erro,
    );

    expect(falha).toBeInstanceOf(FalhaAoListarModelosDaAssinatura);
    expect((falha as FalhaAoListarModelosDaAssinatura).motivo).toBe("formato_de_resposta_desconhecido");
    expect(update).not.toHaveBeenCalled();
  });

  it("queda de rede também é erro visível, não um null que a rota lê como \"sem conta\"", async () => {
    stubDeFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const falha = await listarModelosDaAssinatura("org-1").then(
      () => null,
      (erro: unknown) => erro,
    );

    expect(falha).toBeInstanceOf(FalhaAoListarModelosDaAssinatura);
    expect((falha as FalhaAoListarModelosDaAssinatura).motivo).toBe("sem_resposta_do_backend_do_codex");
    expect(update).not.toHaveBeenCalled();
  });

  it("sem conta conectada continua sendo null — e nenhum fetch acontece", async () => {
    semConta.mockImplementation(() => null);
    const chamada = stubDeFetch(async () => new Response("{}", { status: 200 }));

    expect(await listarModelosDaAssinatura("org-1")).toBeNull();
    expect(chamada).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("CODEX_CLIENT_VERSION declarado viaja como client_version (o parâmetro do Codex CLI)", async () => {
    vi.stubEnv("CODEX_CLIENT_VERSION", "0.160.1");
    // Só a segunda tentativa (o backend do Codex) leva o parâmetro do CLI.
    const chamada = stubDeFetch(async () => new Response("{}", { status: 401 }));
    chamada.mockImplementationOnce(async () => new Response("{}", { status: 401 }));
    chamada.mockImplementationOnce(
      async () => new Response(JSON.stringify({ models: [{ slug: "gpt-a", visibility: "list" }] }), { status: 200 }),
    );

    await listarModelosDaAssinatura("org-1");

    const [url] = chamada.mock.calls[1] as unknown as [string];
    expect(url).toBe(`${ENDPOINT_DO_CODEX}?client_version=0.160.1`);
  });
});

describe("listarModelosDaAssinaturaOuVazio", () => {
  it("falha do backend vira lista vazia com o motivo no log — a rota não cai", async () => {
    respondeCom({ message: "denied" }, 403);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await listarModelosDaAssinaturaOuVazio("org-1")).toEqual([]);
    expect(aviso).toHaveBeenCalledWith("modelos-da-assinatura: listagem falhou", "http_403");
    expect(update).not.toHaveBeenCalled();
  });

  it("sem conta conectada continua lista vazia, sem log de falha", async () => {
    semConta.mockImplementation(() => null);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await listarModelosDaAssinaturaOuVazio("org-1")).toEqual([]);
    expect(aviso).not.toHaveBeenCalled();
  });
});
