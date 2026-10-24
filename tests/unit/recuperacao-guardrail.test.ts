import { describe, expect, it } from "vitest";

import { BEFORE_SEND_GATES, cobrancaGate } from "@/lib/agent-engine/guardrails/before-send";
import { avaliarEnvioDeCobranca, type EstadoDaCobrancaNoEnvio } from "@/lib/recuperacao/guardrail";

// Terça, 15h em São Paulo.
const TERCA_15H = new Date("2026-10-20T18:00:00Z");
const BASE: EstadoDaCobrancaNoEnvio = {
  identidadeConfirmada: true,
  optOut: false,
  resposta: true,
  janela: { horaInicio: 8, horaFim: 20, dias: [1, 2, 3, 4, 5, 6], fuso: "America/Sao_Paulo" },
  descontoMaximoPct: 10,
  maxParcelas: 12,
};
const veto = (corpo: string, e: Partial<EstadoDaCobrancaNoEnvio> = {}, agora = TERCA_15H) =>
  avaliarEnvioDeCobranca(corpo, { ...BASE, ...e }, agora)?.code ?? null;

describe("guardrail de cobrança", () => {
  it("mensagem boa passa", () => {
    expect(veto("Consigo à vista por R$ 3.581,27 (5% de desconto), até 26/10. Fica bom?")).toBeNull();
    expect(veto("Também dá em 12x: entrada de R$ 200,04 + 11x de R$ 324,52.")).toBeNull();
    expect(veto("Assim que o pagamento cair, vou processar a baixa.")).toBeNull();
  });

  it("recusar o parcelamento pedido não é oferecer: \"não consegui em 24 vezes\" passa", () => {
    expect(veto("João, não consegui em 24 vezes. O que tenho é entrada de R$ 188,49 + 11x de R$ 325,57.")).toBeNull();
    expect(veto("Em 24 vezes não dá, mas em 12x fica R$ 325,57.")).toBeNull();
    expect(veto("Faço em 24 vezes de R$ 160,00.")).toBe("cobranca_acima_da_politica");
    expect(veto("Consigo em 24x sem entrada.")).toBe("cobranca_acima_da_politica");
  });

  it("cobrança pausada por cuidado: acolher passa; valor, acordo e mensagem ativa não", () => {
    expect(veto("Sinto muito. Você pode ligar para o CVV, no 188, a qualquer hora.", { cuidado: true })).toBeNull();
    expect(veto("Consigo R$ 3.581,27 à vista.", { cuidado: true })).toBe("cobranca_pausada_por_cuidado");
    expect(veto("Quando quiser, a gente fecha o acordo.", { cuidado: true })).toBe("cobranca_pausada_por_cuidado");
    expect(veto("Oi, João, tudo bem?", { cuidado: true, resposta: false })).toBe("cobranca_pausada_por_cuidado");
  });

  it("valor antes da identidade é vetado; pedir o CPF não é", () => {
    expect(veto("Sua dívida é de R$ 3.769,76.", { identidadeConfirmada: false })).toBe("cobranca_valor_antes_da_identidade");
    expect(veto("O saldo está em 3.769,76", { identidadeConfirmada: false })).toBe("cobranca_valor_antes_da_identidade");
    expect(veto("São 300 reais", { identidadeConfirmada: false })).toBe("cobranca_valor_antes_da_identidade");
    expect(
      veto("Oi, João! Sou a Bella, da Pacare. Pode me confirmar os 3 primeiros dígitos do seu CPF?", {
        identidadeConfirmada: false,
      }),
    ).toBeNull();
  });

  it("CDC art. 42: ameaça e exposição são vetadas", () => {
    for (const frase of [
      "Se não pagar vamos te processar.",
      "Vamos avisar a sua família sobre a dívida.",
      "Seu chefe vai ficar sabendo se você não pagar.",
      "Isso pode dar cadeia.",
      "Que vergonha deixar essa conta aberta.",
      "Último aviso antes de bloquear seu salário.",
    ]) {
      expect(veto(frase), frase).toBe("cobranca_linguagem_abusiva");
    }
  });

  it("desconto e parcelas acima da política", () => {
    expect(veto("Faço com 30% de desconto!")).toBe("cobranca_acima_da_politica");
    expect(veto("Posso parcelar em 24x.")).toBe("cobranca_acima_da_politica");
    expect(veto("Dá em 10 vezes.")).toBeNull();
  });

  it("opt-out e horário só travam mensagem ATIVA", () => {
    expect(veto("Oi, tudo bem?", { optOut: true, resposta: false })).toBe("cobranca_opt_out");
    expect(veto("Claro, posso te ajudar.", { optOut: true, resposta: true })).toBeNull();
    const domingo = new Date("2026-10-25T15:00:00Z");
    expect(veto("Oi, tudo bem?", { resposta: false }, domingo)).toBe("cobranca_fora_do_horario");
    const terca22h = new Date("2026-10-21T01:00:00Z");
    expect(veto("Oi, tudo bem?", { resposta: false }, terca22h)).toBe("cobranca_fora_do_horario");
    expect(veto("Oi, tudo bem?", { resposta: true }, terca22h)).toBeNull();
    // Omitido = ativa (a direção segura).
    expect(veto("Oi", { resposta: undefined }, terca22h)).toBe("cobranca_fora_do_horario");
  });

  it("o gate roda na cadeia, logo depois do LGPD, e não arma sem dívida", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("cobranca")).toBe(nomes.indexOf("lgpd") + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(cobrancaGate.evaluate({ body: "vamos te processar", now: TERCA_15H, cobranca: null } as any)).toEqual({ pass: true });
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cobrancaGate.evaluate({ body: "vamos te processar", now: TERCA_15H, cobranca: BASE } as any),
    ).toMatchObject({ pass: false, code: "cobranca_linguagem_abusiva" });
  });
});
