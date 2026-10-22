/**
 * Servidor do simulador: uma página (ui.html) e uma API JSON pequena, sem
 * banco, sem fila, sem WhatsApp — a Bella responde em segundos e um lote de
 * centenas de conversas roda em paralelo. Tudo em memória + `.bella-sim/`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { PLAYBOOK_DA_BELLA_PATH, playbookDaBella } from "../definicao";
import { AGORA_DO_LAB, DIVIDA_PADRAO, type DividaDoAmbiente } from "../lab/ambiente";
import { MODELO_PADRAO_BELLA, MODELO_PADRAO_PERSONA, SessaoBella, type TurnoDaBella } from "../lab/motor";
import { auditar } from "./auditoria";
import { CATALOGO, cenarioPorId, dividaAleatoria, type CenarioDoSimulador } from "./cenarios";
import { julgar } from "./juiz";
import {
  PASTA,
  agoraDaConversa,
  cancelarLote,
  carregarLotes,
  iniciarLote,
  listarLotes,
  lote,
  reexecutar,
  resumo,
  type PedidoDeLote,
  type ResultadoDaConversa,
} from "./lote";
import { colarRetorno, estadoDoLogin, iniciarLogin, modelosDaAssinatura, sair } from "./chatgpt";
import { PROVEDORES, definirChave, provedoresDisponiveis, type Provedor } from "./modelos";
import { relatorioMarkdown } from "./relatorio";

const ARQUIVO_CHAVES = path.join(PASTA, "chaves.local.json");

function carregarChaves() {
  if (!existsSync(ARQUIVO_CHAVES)) return;
  try {
    const c = JSON.parse(readFileSync(ARQUIVO_CHAVES, "utf8")) as Partial<Record<Provedor, string>>;
    for (const p of PROVEDORES) if (c[p]) definirChave(p, c[p]!);
  } catch {
    // arquivo inválido: ignora
  }
}

function lembrarChave(provedor: Provedor, chave: string | null) {
  mkdirSync(PASTA, { recursive: true });
  let c: Partial<Record<Provedor, string>> = {};
  try {
    c = JSON.parse(readFileSync(ARQUIVO_CHAVES, "utf8"));
  } catch {
    // primeiro uso
  }
  if (chave) c[provedor] = chave;
  else delete c[provedor];
  writeFileSync(ARQUIVO_CHAVES, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// conversa manual
// ---------------------------------------------------------------------------

interface Manual {
  id: string;
  sessao: SessaoBella;
  cenario: CenarioDoSimulador | null;
  turnos: TurnoDaBella[];
  playbook: string;
  ocupada: boolean;
}

const manuais = new Map<string, Manual>();

function retrato(m: Manual) {
  const amb = m.sessao.amb;
  const d = amb.estado.dividas[0]!;
  return {
    id: m.id,
    cenario: m.cenario ? { id: m.cenario.id, titulo: m.cenario.titulo } : null,
    divida: amb.divida,
    agora: amb.agora.toISOString(),
    modelos: { bella: m.sessao.modeloBella, persona: m.sessao.modeloPersona },
    conversa: amb.conversa,
    chamadas: amb.chamadas,
    turnos: m.turnos.map(({ ms, travou, vetos, erro, uso }) => ({ ms, travou, vetos, erro, uso })),
    estado: {
      identidade: d.identidade_verificada_em ? "confirmada" : d.identidade_bloqueada_ate ? "bloqueada" : "pendente",
      tentativas: d.identidade_tentativas,
      status: d.status,
      optOut: d.opt_out_em !== null,
      retornarEm: d.retornar_em,
      acordos: amb.estado.acordos,
      cobrancas: amb.estado.cobrancas,
      tabulacoes: amb.estado.tabulacoes.map((t) => ({ desfecho: t.desfecho, motivo: t.motivo })),
      handoffs: amb.handoffs,
    },
    uso: m.sessao.uso,
  };
}

async function comManual<T>(id: string, f: (m: Manual) => Promise<T>): Promise<T> {
  const m = manuais.get(id);
  if (!m) throw new ErroHttp(404, "conversa não encontrada (o simulador foi reiniciado?)");
  if (m.ocupada) throw new ErroHttp(409, "a Bella ainda está respondendo");
  m.ocupada = true;
  try {
    return await f(m);
  } finally {
    m.ocupada = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ErroHttp extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function corpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  if (partes.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8"));
  } catch {
    throw new ErroHttp(400, "JSON inválido");
  }
}

function json(res: ServerResponse, status: number, dados: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(dados));
}

function itemLeve(i: ResultadoDaConversa) {
  return {
    n: i.n,
    status: i.status,
    cenario: i.cenario,
    devedor: i.divida.nome,
    mensagens: i.conversa.length,
    falhas: i.achados.filter((a) => !a.ok && a.nivel === "falha").map((a) => a.nome),
    alertas: i.achados.filter((a) => !a.ok && a.nivel === "alerta").map((a) => a.nome),
    nota: i.juiz?.nota ?? null,
    acordo: i.acordo,
    handoff: i.handoff,
    desfechos: i.desfechos,
    ms: i.ms,
    erro: i.erro,
  };
}

function texto(v: unknown, padrao = ""): string {
  return typeof v === "string" ? v : padrao;
}

function dividaDoPedido(b: Record<string, unknown>, base: Date): DividaDoAmbiente {
  if (b.variarDivida) return dividaAleatoria(Math.floor(Math.random() * 1e6), base);
  const d = (b.divida ?? {}) as Partial<DividaDoAmbiente>;
  return {
    nome: texto(d.nome, DIVIDA_PADRAO.nome) || DIVIDA_PADRAO.nome,
    credor: texto(d.credor, DIVIDA_PADRAO.credor) || DIVIDA_PADRAO.credor,
    produto: texto(d.produto, DIVIDA_PADRAO.produto) || DIVIDA_PADRAO.produto,
    valorCents: Number(d.valorCents) > 0 ? Math.round(Number(d.valorCents)) : DIVIDA_PADRAO.valorCents,
    vencimento: /^\d{4}-\d{2}-\d{2}$/.test(texto(d.vencimento)) ? texto(d.vencimento) : DIVIDA_PADRAO.vencimento,
    parcelasVencidas: Number(d.parcelasVencidas) > 0 ? Number(d.parcelasVencidas) : DIVIDA_PADRAO.parcelasVencidas,
    cpfPrefixo: /^\d{3}$/.test(texto(d.cpfPrefixo)) ? texto(d.cpfPrefixo) : DIVIDA_PADRAO.cpfPrefixo,
  };
}

async function rotear(req: IncomingMessage, res: ServerResponse, html: () => string) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname.split("/").filter(Boolean);
  const metodo = req.method ?? "GET";

  if (metodo === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html());
    return;
  }
  if (p[0] !== "api") throw new ErroHttp(404, "não encontrado");

  // GET /api/estado
  if (metodo === "GET" && p[1] === "estado") {
    return json(res, 200, {
      provedores: provedoresDisponiveis(),
      chatgpt: estadoDoLogin(),
      modelosPadrao: {
        bella: process.env.BELLA_LAB_MODELO ?? MODELO_PADRAO_BELLA,
        persona: process.env.BELLA_LAB_MODELO_PERSONA ?? MODELO_PADRAO_PERSONA,
        juiz: process.env.BELLA_SIM_MODELO_JUIZ ?? MODELO_PADRAO_BELLA,
      },
      catalogo: CATALOGO.map((c) => ({ id: c.id, titulo: c.titulo, grupo: c.grupo })),
      playbook: playbookDaBella(),
      agoraPadrao: AGORA_DO_LAB.toISOString(),
      dividaPadrao: DIVIDA_PADRAO,
    });
  }

  // POST /api/chave {provedor, chave, lembrar}
  if (metodo === "POST" && p[1] === "chave") {
    const b = await corpo(req);
    const provedor = texto(b.provedor) as Provedor;
    if (!PROVEDORES.includes(provedor)) throw new ErroHttp(400, "provedor inválido");
    const chave = texto(b.chave).trim() || null;
    definirChave(provedor, chave);
    if (b.lembrar || chave === null) lembrarChave(provedor, b.lembrar ? chave : null);
    return json(res, 200, { provedores: provedoresDisponiveis() });
  }

  // ── login com a assinatura do ChatGPT ──
  if (p[1] === "chatgpt") {
    if (metodo === "GET" && p[2] === "estado") return json(res, 200, estadoDoLogin());
    if (metodo === "POST" && p[2] === "iniciar") return json(res, 200, await iniciarLogin());
    if (metodo === "POST" && p[2] === "colar") {
      const b = await corpo(req);
      try {
        await colarRetorno(texto(b.retorno));
      } catch (e) {
        throw new ErroHttp(400, e instanceof Error ? e.message : String(e));
      }
      return json(res, 200, estadoDoLogin());
    }
    if (metodo === "POST" && p[2] === "sair") {
      sair();
      return json(res, 200, estadoDoLogin());
    }
    if (metodo === "GET" && p[2] === "modelos") {
      try {
        return json(res, 200, { modelos: await modelosDaAssinatura() });
      } catch (e) {
        throw new ErroHttp(502, e instanceof Error ? e.message : String(e));
      }
    }
  }

  // POST /api/playbook {texto} — grava o playbook.md de verdade
  if (metodo === "POST" && p[1] === "playbook") {
    const b = await corpo(req);
    const t = texto(b.texto);
    if (t.trim().length < 200) throw new ErroHttp(400, "playbook curto demais — não gravei");
    writeFileSync(PLAYBOOK_DA_BELLA_PATH, t.endsWith("\n") ? t : `${t}\n`);
    return json(res, 200, { ok: true, arquivo: path.relative(process.cwd(), PLAYBOOK_DA_BELLA_PATH) });
  }

  // ── conversa manual ──
  if (p[1] === "manual") {
    if (metodo === "POST" && p.length === 2) {
      const b = await corpo(req);
      const base = texto(b.agora) ? new Date(texto(b.agora)) : AGORA_DO_LAB;
      if (Number.isNaN(base.getTime())) throw new ErroHttp(400, "data/hora inválida");
      const cenario = texto(b.cenario) ? cenarioPorId(texto(b.cenario)) ?? null : null;
      const playbook = texto(b.playbook) || playbookDaBella();
      const sessao = new SessaoBella({
        modeloBella: texto(b.modeloBella) || undefined,
        modeloPersona: texto(b.modeloPersona) || undefined,
        divida: dividaDoPedido(b, base),
        agora: agoraDaConversa(base, cenario?.hora),
        playbook,
      });
      const m: Manual = { id: randomUUID(), sessao, cenario, turnos: [], playbook, ocupada: false };
      manuais.set(m.id, m);
      await comManual(m.id, async () => {
        m.turnos.push(await sessao.vezDaBella());
      });
      return json(res, 200, retrato(m));
    }
    const id = p[2]!;
    if (metodo === "GET" && p.length === 3) {
      const m = manuais.get(id);
      if (!m) throw new ErroHttp(404, "conversa não encontrada");
      return json(res, 200, retrato(m));
    }
    if (metodo === "POST" && p[3] === "falar") {
      const b = await corpo(req);
      const t = texto(b.texto).trim();
      if (!t) throw new ErroHttp(400, "mensagem vazia");
      return json(
        res,
        200,
        await comManual(id, async (m) => {
          m.sessao.devedorDiz(t);
          m.turnos.push(await m.sessao.vezDaBella());
          return retrato(m);
        }),
      );
    }
    if (metodo === "POST" && p[3] === "persona") {
      return json(
        res,
        200,
        await comManual(id, async (m) => {
          if (!m.cenario) throw new ErroHttp(400, "esta conversa não tem cenário: escolha um para a persona falar sozinha");
          const fala = await m.sessao.falaDaPersona(m.cenario.persona(m.sessao.amb.divida), m.cenario.cpf(m.sessao.amb.divida));
          if (fala === null) return { ...retrato(m), personaEncerrou: true };
          m.sessao.devedorDiz(fala);
          m.turnos.push(await m.sessao.vezDaBella());
          return retrato(m);
        }),
      );
    }
    if (metodo === "POST" && p[3] === "auditar") {
      const b = await corpo(req);
      return json(
        res,
        200,
        await comManual(id, async (m) => {
          const cen = m.cenario ?? { id: "manual", titulo: "manual", grupo: "base", persona: () => "", cpf: () => "", espera: {} };
          const achados = auditar(cen as CenarioDoSimulador, m.sessao.amb, m.turnos);
          const juiz = texto(b.modeloJuiz) ? await julgar(m.sessao.amb, m.playbook, texto(b.modeloJuiz)) : undefined;
          return { achados, juiz };
        }),
      );
    }
  }

  // ── lotes ──
  if (p[1] === "lotes") {
    if (metodo === "GET" && p.length === 2) {
      return json(
        res,
        200,
        listarLotes().map((l) => ({
          id: l.id,
          nome: l.nome,
          criadoEm: l.criadoEm,
          status: l.status,
          modelos: { bella: l.pedido.modeloBella, persona: l.pedido.modeloPersona, juiz: l.pedido.modeloJuiz },
          resumo: resumo(l),
        })),
      );
    }
    if (metodo === "POST" && p.length === 2) {
      const b = (await corpo(req)) as unknown as PedidoDeLote;
      const total = (b.cenarios?.length ?? 0) * Math.max(1, Number(b.repeticoes) || 1) + (Number(b.caos) || 0);
      if (total > 1000) throw new ErroHttp(400, "no máximo 1000 conversas por lote");
      const l = iniciarLote({
        nome: texto(b.nome),
        cenarios: Array.isArray(b.cenarios) ? b.cenarios.map(String) : [],
        repeticoes: Math.max(1, Number(b.repeticoes) || 1),
        caos: Math.max(0, Number(b.caos) || 0),
        variarDivida: !!b.variarDivida,
        concorrencia: Math.max(1, Number(b.concorrencia) || 4),
        modeloBella: texto(b.modeloBella) || MODELO_PADRAO_BELLA,
        modeloPersona: texto(b.modeloPersona) || MODELO_PADRAO_PERSONA,
        modeloJuiz: texto(b.modeloJuiz) || null,
        playbook: texto(b.playbook) || undefined,
        maxTurnos: Math.min(30, Math.max(2, Number(b.maxTurnos) || 14)),
        agora: texto(b.agora) || undefined,
      });
      return json(res, 200, { id: l.id });
    }
    const l = lote(p[2] ?? "");
    if (!l) throw new ErroHttp(404, "lote não encontrado");
    if (metodo === "GET" && p.length === 3) {
      return json(res, 200, {
        id: l.id,
        nome: l.nome,
        criadoEm: l.criadoEm,
        terminadoEm: l.terminadoEm,
        status: l.status,
        pedido: l.pedido,
        playbookUsado: l.playbookUsado,
        resumo: resumo(l),
        itens: l.itens.map(itemLeve),
      });
    }
    if (metodo === "POST" && p[3] === "cancelar") {
      cancelarLote(l.id);
      return json(res, 200, { ok: true });
    }
    if (metodo === "GET" && p[3] === "relatorio.md") {
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="bella-lote-${l.id}.md"`,
      });
      res.end(relatorioMarkdown(l));
      return;
    }
    if (metodo === "GET" && p[3] === "exportar") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="bella-lote-${l.id}.json"`,
      });
      res.end(JSON.stringify(l, null, 1));
      return;
    }
    if (p[3] === "itens") {
      const n = Number(p[4]);
      const item = l.itens.find((i) => i.n === n);
      if (!item) throw new ErroHttp(404, "conversa não encontrada");
      if (metodo === "GET" && p.length === 5) return json(res, 200, item);
      if (metodo === "POST" && p[5] === "reexecutar") {
        const b = await corpo(req);
        return json(res, 200, await reexecutar(l, n, texto(b.playbook) ? { playbook: texto(b.playbook) } : {}));
      }
    }
  }
  throw new ErroHttp(404, "rota não encontrada");
}

export function iniciarServidor(opcoes: { porta: number; host: string; html: () => string }) {
  carregarChaves();
  carregarLotes();
  const srv = createServer((req, res) => {
    rotear(req, res, opcoes.html).catch((e: unknown) => {
      const status = e instanceof ErroHttp ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { erro: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
  srv.listen(opcoes.porta, opcoes.host);
  return srv;
}
