/**
 * Laboratório da Bella.
 *
 *   pnpm bella:lab                 # offline: roteiros, sem modelo (roda em qualquer lugar)
 *   pnpm bella:lab --modelo        # conversa de verdade com modelo (precisa de ANTHROPIC_API_KEY)
 *   pnpm bella:lab --modelo --juiz # + nota de tom por modelo
 *   pnpm bella:lab --cenario cem_por_mes
 *
 * Grava o relatório em .bella-lab/relatorio-<data>.json e sai com código 1 se
 * algum cenário reprovar.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { conferir, passou } from "@/lib/recuperacao/bella/lab/conferencia";
import { CENARIOS } from "@/lib/recuperacao/bella/lab/cenarios";
import { conversarComModelo, julgarTom } from "@/lib/recuperacao/bella/lab/motor";
import { ROTEIROS, ROTEIRO_DA_MIA, cenarioPorId, executarRoteiro } from "@/lib/recuperacao/bella/lab/roteiros";

const args = process.argv.slice(2);
const comModelo = args.includes("--modelo");
const comJuiz = args.includes("--juiz");
const filtro = args.includes("--cenario") ? args[args.indexOf("--cenario") + 1] : undefined;

async function main() {
  const cenarios = CENARIOS.filter((c) => !filtro || c.id === filtro);
  const relatorio: Array<Record<string, unknown>> = [];
  let reprovados = 0;

  for (const cenario of cenarios) {
    const amb = comModelo ? await conversarComModelo(cenario) : await executarRoteiro(ROTEIROS[cenario.id] ?? []);
    const criterios = conferir(cenario, amb);
    const ok = passou(criterios);
    if (!ok) reprovados++;
    const tom = comModelo && comJuiz ? await julgarTom(amb) : undefined;
    console.info(`${ok ? "✓" : "✗"} ${cenario.titulo}`);
    for (const c of criterios.filter((x) => !x.ok)) console.info(`    ✗ ${c.nome}${c.detalhe ? ` — ${c.detalhe}` : ""}`);
    const vetos = amb.conversa.flatMap((m) => m.vetos);
    if (vetos.length) console.info(`    · guardrail vetou e a Bella reescreveu: ${vetos.join(", ")}`);
    if (tom) console.info(`    · tom: ${JSON.stringify(tom)}`);
    relatorio.push({ cenario: cenario.id, ok, criterios, conversa: amb.conversa, chamadas: amb.chamadas.map((c) => c.nome), tom });
  }

  if (!comModelo && !filtro) {
    // Controle negativo: o juiz tem de reprovar a conversa da Mia.
    const mia = await executarRoteiro(ROTEIRO_DA_MIA);
    const criterios = conferir(cenarioPorId("colaborativo_a_vista"), mia);
    const reprovou = !passou(criterios);
    console.info(`${reprovou ? "✓" : "✗"} controle negativo: o juiz reprova a conversa que fecha sem mandar pagamento (como a Mia)`);
    if (!reprovou) reprovados++;
  }

  const dir = path.join(process.cwd(), ".bella-lab");
  mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, `relatorio-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(arquivo, JSON.stringify({ modo: comModelo ? "modelo" : "offline", relatorio }, null, 2));
  console.info(`\n${cenarios.length - reprovados}/${cenarios.length} cenários aprovados · relatório: ${path.relative(process.cwd(), arquivo)}`);
  process.exit(reprovados > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
