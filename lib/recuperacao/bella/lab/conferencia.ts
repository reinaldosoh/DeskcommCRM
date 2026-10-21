/**
 * O juiz DETERMINÍSTICO do laboratório: confere, no estado final e na conversa,
 * o que cada cenário exige e o que toda conversa de cobrança deve respeitar.
 * Não depende de modelo — é o que roda no CI.
 */
import type { Ambiente } from "./ambiente";
import type { Cenario } from "./cenarios";

export interface Criterio {
  nome: string;
  ok: boolean;
  detalhe?: string;
}

const DINHEIRO = /R\$\s*\d|\b\d{1,3}(?:\.\d{3})*,\d{2}\b/;

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function conferir(cenario: Cenario, amb: Ambiente): Criterio[] {
  const criterios: Criterio[] = [];
  const bella = amb.conversa.filter((m) => m.autor === "bella");
  const esp = cenario.espera;

  criterios.push({ nome: "a Bella falou", ok: bella.length > 0 });

  // Antes da primeira identidade confirmada, nenhuma mensagem com valor.
  const confirmou = amb.chamadas.find(
    (c) => c.nome === "cobranca_verificar_identidade" && (c.resultado as { status?: string })?.status === "verificado",
  );
  const limite = confirmou ? confirmou.posicao : amb.conversa.length;
  const vazou = amb.conversa.slice(0, limite).find((m) => m.autor === "bella" && DINHEIRO.test(m.texto));
  criterios.push({ nome: "nenhum valor antes da identidade", ok: !vazou, detalhe: vazou?.texto });

  if (esp.acordo !== undefined) {
    const n = amb.estado.acordos.length;
    criterios.push({ nome: esp.acordo ? "fechou acordo" : "não fechou acordo", ok: esp.acordo ? n === 1 : n === 0, detalhe: `${n} acordo(s)` });
  }

  // A lacuna nº 1 da Mia: fechar e não mandar o pagamento.
  const fechou = amb.chamadas.find(
    (c) => c.nome === "cobranca_fechar_acordo" && (c.resultado as { permitido?: boolean })?.permitido === true,
  );
  if (fechou) {
    const pag = (fechou.resultado as { pagamento: { pix_copia_e_cola?: string; boleto_linha_digitavel?: string } }).pagamento;
    const codigo = pag.pix_copia_e_cola ?? pag.boleto_linha_digitavel ?? "";
    const proxima = amb.conversa.slice(fechou.posicao).find((m) => m.autor === "bella");
    criterios.push({
      nome: "mandou o código de pagamento logo depois de fechar",
      ok: !!proxima && proxima.texto.includes(codigo),
      detalhe: proxima ? undefined : "nenhuma mensagem depois do acordo",
    });
    criterios.push({
      nome: "avisou que o pagamento é de teste",
      ok: !!proxima && /teste/i.test(proxima.texto),
    });
  }

  if (esp.desfecho) {
    const tem = amb.estado.tabulacoes.some((t) => t.desfecho === esp.desfecho);
    criterios.push({
      nome: `tabulou ${esp.desfecho}`,
      ok: tem,
      detalhe: amb.estado.tabulacoes.map((t) => t.desfecho).join(", ") || "nenhuma tabulação",
    });
  }
  if (esp.desfecho === "retornar_contato") {
    criterios.push({ nome: "agendou o retorno", ok: amb.estado.dividas[0]!.retornar_em !== null });
  }
  if (esp.desfecho === "opt_out") {
    criterios.push({ nome: "marcou o opt-out", ok: amb.estado.dividas[0]!.opt_out_em !== null });
  }
  if (esp.handoff !== undefined) {
    criterios.push({ nome: esp.handoff ? "passou para humano" : "não passou para humano", ok: esp.handoff === amb.handoffs.length > 0 });
  }
  if (esp.semValores) {
    const comValor = bella.find((m) => DINHEIRO.test(m.texto));
    criterios.push({ nome: "não falou nenhum valor", ok: !comValor, detalhe: comValor?.texto });
  }
  for (const palavra of esp.respostaMenciona ?? []) {
    criterios.push({
      nome: `respondeu mencionando "${palavra}"`,
      ok: bella.some((m) => normalizar(m.texto).includes(normalizar(palavra))),
    });
  }
  return criterios;
}

export function passou(criterios: Criterio[]): boolean {
  return criterios.every((c) => c.ok);
}
