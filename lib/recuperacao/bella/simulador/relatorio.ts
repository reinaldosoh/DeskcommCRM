/**
 * Relatório de um lote em Markdown: o resumo e cada conversa reprovada, com a
 * transcrição e o que falhou — o formato para colar numa conversa com o
 * Claude ("corrija a Bella a partir disto") ou guardar junto do playbook.
 */
import { resumo, type Lote, type ResultadoDaConversa } from "./lote";

function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}

function conversa(i: ResultadoDaConversa): string {
  let c = 0;
  const linhas: string[] = [];
  i.conversa.forEach((m, k) => {
    for (; c < i.chamadas.length && i.chamadas[c]!.posicao <= k; c++) {
      const ch = i.chamadas[c]!;
      linhas.push(`    ⚙ ${ch.nome}(${JSON.stringify(ch.args)}) → ${JSON.stringify(ch.resultado).slice(0, 300)}`);
    }
    if (m.autor === "sistema") linhas.push(`--- o tempo passou: ${m.em ?? ""} ---`);
    else linhas.push(`${m.autor === "bella" ? "BELLA" : "DEVEDOR"}: ${m.texto.replace(/\n/g, "\n    ")}`);
    for (const v of m.vetos) linhas.push(`    ⛔ (antes desta, o guardrail vetou: ${v})`);
  });
  for (; c < i.chamadas.length; c++) linhas.push(`    ⚙ ${i.chamadas[c]!.nome}(${JSON.stringify(i.chamadas[c]!.args)})`);
  return linhas.join("\n");
}

export function relatorioMarkdown(l: Lote): string {
  const r = resumo(l);
  const out: string[] = [];
  out.push(`# Lote "${l.nome}" (${l.id})`);
  out.push("");
  out.push(
    `${r.feitos}/${r.total} conversas · **${pct(r.taxa)} aprovadas** (${r.aprovadas}) · ${r.reprovadas} reprovadas · ${r.erros} com erro` +
      (r.notaMedia !== null ? ` · nota média do juiz ${r.notaMedia.toFixed(1)}` : "") +
      (r.msPorResposta !== null ? ` · ${(r.msPorResposta / 1000).toFixed(1)} s por resposta` : ""),
  );
  out.push("");
  out.push(`Modelos: Bella \`${l.pedido.modeloBella}\` · devedor \`${l.pedido.modeloPersona}\` · juiz \`${l.pedido.modeloJuiz ?? "desligado"}\``);
  out.push("");
  if (r.falhas.length) {
    out.push("## O que mais reprovou");
    for (const [nome, n] of r.falhas) out.push(`- ${nome}: ${n}`);
    out.push("");
  }
  if (r.violacoes.length) {
    out.push("## Violações apontadas pelo juiz");
    for (const [nome, n] of r.violacoes) out.push(`- ${nome}: ${n}`);
    out.push("");
  }
  if (r.vetos.length) {
    out.push("## Vetos do guardrail (a Bella tentou e foi barrada)");
    for (const [nome, n] of r.vetos) out.push(`- ${nome}: ${n}`);
    out.push("");
  }
  out.push("## Por cenário");
  for (const c of r.porCenario) out.push(`- ${c.titulo}: ${c.aprovadas}/${c.total}`);
  out.push("");
  const ruins = l.itens.filter((i) => i.status === "reprovada" || i.status === "erro");
  if (ruins.length) {
    out.push("## Conversas reprovadas");
    for (const i of ruins) {
      out.push("");
      out.push(`### #${i.n} — ${i.cenario.titulo} (${i.divida.nome}, ${i.divida.credor})`);
      if (i.erro) out.push(`Erro: ${i.erro}`);
      for (const a of i.achados.filter((x) => !x.ok)) out.push(`- ${a.nivel === "falha" ? "✗" : "△"} ${a.nome}${a.detalhe ? ` — ${a.detalhe}` : ""}`);
      for (const v of i.juiz?.violacoes ?? []) out.push(`- juiz (${v.gravidade}): ${v.regra} — "${v.trecho}" — ${v.por_que}`);
      out.push("");
      out.push("```");
      out.push(conversa(i));
      out.push("```");
    }
  }
  return out.join("\n") + "\n";
}
