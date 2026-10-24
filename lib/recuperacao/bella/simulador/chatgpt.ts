/**
 * Login com a ASSINATURA do ChatGPT no simulador — o mesmo "Sign in with
 * ChatGPT" (SIWC) que o app usa em IA › Credenciais, sem banco: os tokens
 * ficam na memória do processo e em `.bella-sim/chatgpt.local.json` (fora do
 * git, permissão 600), no computador de quem roda o simulador.
 *
 * Fluxo: a tela pede `iniciar` → abre a URL de autorização da OpenAI → o
 * navegador volta para `http://127.0.0.1:1455/auth/callback` (o redirect
 * registrado do cliente SIWC), que este módulo escuta por alguns minutos e
 * troca pelo par de tokens. Se a porta estiver ocupada, a pessoa cola o
 * endereço de retorno na tela (`colarRetorno`), como no app.
 *
 * As chamadas de modelo vão à API pública de Responses com o access_token
 * como Bearer, em streaming e `store:false` (exigência do SIWC) — ver
 * `gerar()` em `modelos.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import {
  CLIENTE_DINAMICO_SIWC,
  criarSessaoPkce,
  gerarNonceSiwc,
  lerRetornoColado,
  novoHostIdSiwc,
  renovarPorRefreshToken,
  trocarCodigoPorTokens,
  type TokensDoCodex,
} from "@/lib/ai/pontos/pkce-da-assinatura";

const PASTA = path.join(process.cwd(), ".bella-sim");
const ARQUIVO = path.join(PASTA, "chatgpt.local.json");
const PORTA_DO_RETORNO = 1455;
const RENOVAR_ANTES_MS = 5 * 60_000;

interface Guardado {
  tokens: TokensDoCodex | null;
  hostId: string;
}

let guardado: Guardado | null = null;
let pendente: { estado: string; codeVerifier: string; nonce: string; expira: number } | null = null;
let escuta: Server | null = null;
let ultimoErro: string | null = null;

function ler(): Guardado {
  if (guardado) return guardado;
  try {
    if (existsSync(ARQUIVO)) guardado = JSON.parse(readFileSync(ARQUIVO, "utf8")) as Guardado;
  } catch {
    guardado = null;
  }
  guardado ??= { tokens: null, hostId: novoHostIdSiwc() };
  return guardado;
}

function gravar() {
  mkdirSync(PASTA, { recursive: true });
  writeFileSync(ARQUIVO, JSON.stringify(ler(), null, 2), { mode: 0o600 });
}

/** O payload do id_token, sem conferir assinatura (uso local: só nonce e e-mail). */
function payloadDo(idToken: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from((idToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function estadoDoLogin() {
  const t = ler().tokens;
  return {
    conectado: !!t,
    email: t?.email ?? (payloadDo(t?.id_token).email as string | undefined) ?? null,
    aguardando: !!pendente && pendente.expira > Date.now(),
    // Um retorno repetido (dois cliques em Entrar) falha DEPOIS do login bom: conectado, o erro velho não importa.
    erro: t ? null : ultimoErro,
  };
}

async function concluir(retornoBruto: string): Promise<void> {
  const r = lerRetornoColado(retornoBruto);
  if (!r) throw new Error("não reconheci o endereço de retorno — cole a URL inteira da barra do navegador");
  if (r.error) throw new Error(r.error === "access_denied" ? "o login foi recusado na tela da OpenAI" : r.error);
  if (!pendente || pendente.estado !== r.state || pendente.expira < Date.now()) {
    throw new Error("este retorno não é do último login iniciado (ou expirou) — clique em Entrar de novo");
  }
  const clientId = r.clientId ?? CLIENTE_DINAMICO_SIWC;
  const tokens = await trocarCodigoPorTokens({ code: r.code, codeVerifier: pendente.codeVerifier, clientId });
  const payload = payloadDo(tokens.id_token);
  if (payload.nonce && payload.nonce !== pendente.nonce) throw new Error("identidade não confere (nonce) — tente de novo");
  if (!tokens.scopes?.includes("chatgpt.tokens.use.direct")) {
    throw new Error("a conta não liberou o uso da assinatura para apps (plano sem 'chatgpt.tokens.use.direct')");
  }
  ler().tokens = { ...tokens, client_id: clientId, email: tokens.email ?? (payload.email as string | undefined) };
  pendente = null;
  ultimoErro = null;
  gravar();
}

function fecharEscuta() {
  escuta?.close();
  escuta = null;
}

/** Abre o login: devolve a URL da OpenAI e passa a escutar o retorno na 1455 (se der). */
export async function iniciarLogin(): Promise<{ url: string; escutando: boolean }> {
  const g = ler();
  const estado = `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const nonce = gerarNonceSiwc();
  const s = criarSessaoPkce(estado, { nonce, extAgentHostId: g.hostId });
  pendente = { estado, codeVerifier: s.codeVerifier, nonce, expira: Date.now() + 10 * 60_000 };
  ultimoErro = null;
  gravar();

  fecharEscuta();
  const escutando = await new Promise<boolean>((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA_DO_RETORNO}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      let html: string;
      try {
        await concluir(url.toString());
        html = "<h2>Pronto! A conta do ChatGPT está conectada ao simulador.</h2><p>Pode fechar esta aba e voltar ao simulador.</p>";
      } catch (e) {
        ultimoErro = e instanceof Error ? e.message : String(e);
        html = `<h2>Não deu certo</h2><p>${ultimoErro.replace(/[<>&]/g, "")}</p><p>Volte ao simulador e tente de novo.</p>`;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${html}</body>`);
      setTimeout(fecharEscuta, 500);
    });
    srv.once("error", () => resolve(false));
    srv.listen(PORTA_DO_RETORNO, "127.0.0.1", () => {
      escuta = srv;
      setTimeout(fecharEscuta, 10 * 60_000).unref();
      resolve(true);
    });
  });
  return { url: s.url, escutando };
}

export async function colarRetorno(texto: string) {
  await concluir(texto);
  fecharEscuta();
}

export function sair() {
  ler().tokens = null;
  pendente = null;
  gravar();
}

let renovando: Promise<void> | null = null;

/** O access_token válido agora (renova pelo refresh_token quando está perto de vencer). */
export async function tokenDaAssinatura(): Promise<string> {
  const g = ler();
  if (!g.tokens) throw new Error("conta do ChatGPT não conectada — entre em Configurar › Entrar com ChatGPT");
  const t = g.tokens;
  if (t.expires_at !== null && t.expires_at - Date.now() < RENOVAR_ANTES_MS) {
    renovando ??= (async () => {
      try {
        const novo = await renovarPorRefreshToken({ refreshToken: t.refresh_token, clientId: t.client_id ?? CLIENTE_DINAMICO_SIWC });
        g.tokens = { ...t, ...novo, client_id: t.client_id, email: t.email };
        gravar();
      } finally {
        renovando = null;
      }
    })();
    await renovando;
  }
  return g.tokens!.access_token;
}

/** Os modelos que a assinatura libera (documentação SIWC: GET /v1/models → { models: [{ slug }] }). */
export async function modelosDaAssinatura(): Promise<string[]> {
  const token = await tokenDaAssinatura();
  const r = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`a OpenAI respondeu ${r.status} ao listar os modelos`);
  const j = (await r.json()) as { models?: Array<{ slug?: string; visibility?: string }>; data?: Array<{ id?: string }> };
  const lista = j.models?.filter((m) => m.visibility !== "hide").map((m) => m.slug) ?? j.data?.map((m) => m.id) ?? [];
  return lista.filter((x): x is string => !!x);
}
