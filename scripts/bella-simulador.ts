/**
 * Simulador da Bella: conversa manual estilo WhatsApp e lotes de dezenas ou
 * centenas de atendimentos simulados, com auditoria automática.
 *
 *   pnpm bella:sim                       # abre em http://127.0.0.1:4545
 *   pnpm bella:sim --host 0.0.0.0        # acessível pelo celular na mesma rede
 *   pnpm bella:sim --lote [--cenarios todos|id,id] [--caos 50] [--repeticoes 2]
 *                  [--concorrencia 6] [--sem-juiz] [--variar]
 *                                        # roda um lote sem tela e grava o relatório
 *
 * Chaves: ANTHROPIC_API_KEY / OPENAI_API_KEY / MODELROUTER_API_KEY no ambiente
 * (ou .env.local), ou coladas na tela em Configurar.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MODELO_PADRAO_BELLA, MODELO_PADRAO_PERSONA } from "@/lib/recuperacao/bella/lab/motor";
import { CATALOGO } from "@/lib/recuperacao/bella/simulador/cenarios";
import { PASTA, iniciarLote, resumo } from "@/lib/recuperacao/bella/simulador/lote";
import { relatorioMarkdown } from "@/lib/recuperacao/bella/simulador/relatorio";
import { iniciarServidor } from "@/lib/recuperacao/bella/simulador/servidor";

const args = process.argv.slice(2);
function arg(nome: string): string | undefined {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const UI = path.join(process.cwd(), "lib", "recuperacao", "bella", "simulador", "ui.html");

async function semTela() {
  const ids = arg("cenarios");
  const cenarios = !ids || ids === "todos" ? CATALOGO.map((c) => c.id) : ids.split(",");
  const l = iniciarLote({
    nome: arg("nome") ?? "linha de comando",
    cenarios: ids === "nenhum" ? [] : cenarios,
    repeticoes: Number(arg("repeticoes") ?? 1),
    caos: Number(arg("caos") ?? 0),
    variarDivida: args.includes("--variar"),
    concorrencia: Number(arg("concorrencia") ?? 6),
    modeloBella: arg("modelo") ?? process.env.BELLA_LAB_MODELO ?? MODELO_PADRAO_BELLA,
    modeloPersona: arg("modelo-persona") ?? process.env.BELLA_LAB_MODELO_PERSONA ?? MODELO_PADRAO_PERSONA,
    modeloJuiz: args.includes("--sem-juiz") ? null : (arg("modelo-juiz") ?? process.env.BELLA_SIM_MODELO_JUIZ ?? MODELO_PADRAO_BELLA),
    maxTurnos: Number(arg("turnos") ?? 14),
  });
  let ultimo = -1;
  while (l.status === "rodando") {
    await new Promise((r) => setTimeout(r, 1000));
    const r = resumo(l);
    if (r.feitos !== ultimo) {
      ultimo = r.feitos;
      console.info(`  ${r.feitos}/${r.total} · ${r.aprovadas} aprovadas · ${r.reprovadas} reprovadas · ${r.erros} erros`);
    }
  }
  const r = resumo(l);
  mkdirSync(PASTA, { recursive: true });
  const arquivo = path.join(PASTA, `relatorio-${l.id}.md`);
  writeFileSync(arquivo, relatorioMarkdown(l));
  console.info(`\n${Math.round(r.taxa * 100)}% aprovadas (${r.aprovadas}/${r.feitos}) · relatório: ${path.relative(process.cwd(), arquivo)}`);
  for (const [nome, n] of r.falhas.slice(0, 8)) console.info(`  ✗ ${nome}: ${n}`);
  process.exit(r.erros === r.feitos ? 1 : 0);
}

if (args.includes("--lote")) {
  semTela().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  const porta = Number(arg("porta") ?? process.env.BELLA_SIM_PORTA ?? 4545);
  const host = arg("host") ?? "127.0.0.1";
  iniciarServidor({ porta, host, html: () => readFileSync(UI, "utf8") });
  console.info(`\n  Simulador da Bella: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${porta}\n`);
}
