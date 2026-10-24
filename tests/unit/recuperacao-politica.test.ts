/**
 * Regras de negociação da Bella (lib/recuperacao/politica.ts).
 *
 * Os números da Mia vêm do teste real feito no WhatsApp em 20/10/2026: saldo
 * R$ 3.769,76, parcelado em entrada R$ 200,04 + 11× R$ 324,52.
 */
import { describe, expect, it } from "vitest";

import {
  POLITICA_PADRAO,
  avaliarPedido,
  diasDeAtraso,
  escadaDeOfertas,
  proximoDegrauAVista,
  faixaVigente,
  melhorParceladoPossivel,
  propostaAVista,
  propostaParcelada,
  propostaRespeitaPolitica,
} from "@/lib/recuperacao/politica";
import type { Divida } from "@/lib/recuperacao/tipos";

const HOJE = new Date("2026-10-20T15:00:00Z");
const MIA: Divida = {
  id: "d1",
  credor: "Banco Nova Era",
  produto: "cartão de crédito",
  saldoCents: 376_976,
  vencimentoOriginal: "2026-03-10", // 224 dias: faixa 180+
};

describe("atraso e faixa", () => {
  it("conta dias corridos e escolhe a maior faixa que cabe", () => {
    expect(diasDeAtraso(MIA, HOJE)).toBe(224);
    expect(faixaVigente(POLITICA_PADRAO, 224).diasMinimos).toBe(180);
    expect(faixaVigente(POLITICA_PADRAO, 29).descontoMaximoPct).toBe(0);
  });

  it("dívida ainda não vencida tem atraso zero", () => {
    expect(diasDeAtraso({ ...MIA, vencimentoOriginal: "2026-12-01" }, HOJE)).toBe(0);
  });
});

describe("à vista", () => {
  it("usa o desconto inicial da faixa e vence no prazo da política", () => {
    const p = propostaAVista(MIA, POLITICA_PADRAO, HOJE);
    expect(p.descontoPct).toBe(5);
    expect(p.totalCents).toBe(376_976 - 18_849);
    expect(p.primeiroVencimento).toBe("2026-10-26");
  });

  it("nunca passa do teto da faixa, mesmo se pedirem", () => {
    expect(propostaAVista(MIA, POLITICA_PADRAO, HOJE, 40).descontoPct).toBe(10);
  });
});

describe("parcelado", () => {
  it("reproduz exatamente o parcelamento da Mia quando a entrada é R$ 200,04", () => {
    const r = propostaParcelada(MIA, POLITICA_PADRAO, HOJE, { parcelas: 12, entradaCents: 20_004 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposta.parcelaCents).toBe(32_452);
    expect(r.proposta.entradaCents).toBe(20_004);
    expect(r.proposta.entradaCents + 11 * r.proposta.parcelaCents).toBe(MIA.saldoCents);
  });

  it("o centavo que sobra vai para a entrada e o total fecha sempre", () => {
    for (let n = 2; n <= 12; n++) {
      const r = propostaParcelada(MIA, POLITICA_PADRAO, HOJE, { parcelas: n });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.proposta.entradaCents + (n - 1) * r.proposta.parcelaCents).toBe(r.proposta.totalCents);
      expect(r.proposta.entradaCents).toBeGreaterThanOrEqual(r.proposta.parcelaCents > 0 ? 18_849 : 0);
    }
  });

  it("recusa acima do máximo, entrada baixa e parcela miúda", () => {
    expect(propostaParcelada(MIA, POLITICA_PADRAO, HOJE, { parcelas: 13 })).toMatchObject({
      ok: false,
      motivo: "parcelas_acima_do_maximo",
    });
    expect(propostaParcelada(MIA, POLITICA_PADRAO, HOJE, { parcelas: 6, entradaCents: 1_000 })).toMatchObject({
      ok: false,
      motivo: "entrada_abaixo_do_minimo",
    });
    const pequena: Divida = { ...MIA, saldoCents: 20_000 };
    expect(propostaParcelada(pequena, POLITICA_PADRAO, HOJE, { parcelas: 12 })).toMatchObject({
      ok: false,
      motivo: "parcela_abaixo_do_minimo",
    });
    expect(propostaParcelada(MIA, POLITICA_PADRAO, HOJE, { parcelas: 1 })).toMatchObject({
      ok: false,
      motivo: "parcelas_invalidas",
    });
  });
});

describe("avaliar o pedido do devedor", () => {
  it("'consigo R$ 100 por mês' vira contraproposta dentro da política", () => {
    const a = avaliarPedido(MIA, POLITICA_PADRAO, HOJE, {
      forma: "parcelado",
      valorParcelaDesejadoCents: 10_000,
    });
    expect(a.aceitavel).toBe(false);
    if (a.aceitavel) return;
    expect(a.motivo).toBe("parcelas_acima_do_maximo");
    expect(a.contraproposta.parcelas).toBe(12);
  });

  it("à vista com valor abaixo do piso: recusa e oferece o piso", () => {
    const a = avaliarPedido(MIA, POLITICA_PADRAO, HOJE, { forma: "a_vista", totalDesejadoCents: 200_000 });
    expect(a).toMatchObject({ aceitavel: false, motivo: "valor_abaixo_do_permitido" });
    if (a.aceitavel) return;
    expect(a.contraproposta.descontoPct).toBe(10);
  });

  it("à vista com valor dentro do piso: aceita sem cobrar menos do que ofereceram", () => {
    const a = avaliarPedido(MIA, POLITICA_PADRAO, HOJE, { forma: "a_vista", totalDesejadoCents: 350_000 });
    expect(a.aceitavel).toBe(true);
    if (!a.aceitavel) return;
    expect(a.proposta.totalCents).toBeGreaterThanOrEqual(350_000);
  });
});

describe("escada e conferência", () => {
  it("abre com o inicial e o parcelado — o teto da faixa nunca aparece", () => {
    const escada = escadaDeOfertas(MIA, POLITICA_PADRAO, HOJE);
    expect(escada.map((p) => [p.forma, p.descontoPct])).toEqual([
      ["a_vista", 5],
      ["parcelado", 0],
    ]);
    expect(escadaDeOfertas(MIA, POLITICA_PADRAO, HOJE, 6.5)[0]!.descontoPct).toBe(6.5);
    const semFaixa = escadaDeOfertas({ ...MIA, vencimentoOriginal: "2026-10-10" }, POLITICA_PADRAO, HOJE);
    expect(semFaixa).toHaveLength(2);
  });

  it("o desconto sobe meio ponto por degrau, sem pular, até o teto", () => {
    const degraus: number[] = [];
    let liberado: number | null = null;
    for (;;) {
      const d = proximoDegrauAVista(MIA, POLITICA_PADRAO, HOJE, liberado);
      if (d.esgotado) break;
      degraus.push(d.descontoPct);
      liberado = d.descontoPct;
    }
    expect(degraus).toEqual([5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]);
  });

  it("com valor proposto, para no menor desconto que chega nele — sem saltar", () => {
    // R$ 3.560 cabe em 5,57% → na grade de 0,5: 6%? não — 5,5% não chega, 6% chega, mas 6% é 2 degraus: sobe só 1.
    const um = proximoDegrauAVista(MIA, POLITICA_PADRAO, HOJE, null, 356_000);
    expect(um).toMatchObject({ esgotado: false, descontoPct: 5.5, alcancaOProposto: false });
    // Do 5,5%, o 6% alcança: para nele.
    const dois = proximoDegrauAVista(MIA, POLITICA_PADRAO, HOJE, 5.5, 356_000);
    expect(dois).toMatchObject({ esgotado: false, descontoPct: 6, alcancaOProposto: true });
    // Valor que o liberado já cobre: não dá desconto a mais.
    const ja = proximoDegrauAVista(MIA, POLITICA_PADRAO, HOJE, 6, 360_000);
    expect(ja).toMatchObject({ esgotado: false, descontoPct: 6, alcancaOProposto: true });
  });

  it("pedir desconto acima do liberado não fecha, mesmo dentro do teto", () => {
    const a = avaliarPedido(MIA, POLITICA_PADRAO, HOJE, { forma: "a_vista", descontoPct: 10 }, 5.5);
    expect(a).toMatchObject({ aceitavel: false, motivo: "desconto_nao_liberado" });
    if (!a.aceitavel) expect(a.contraproposta.descontoPct).toBe(5.5);
    expect(avaliarPedido(MIA, POLITICA_PADRAO, HOJE, { forma: "a_vista", descontoPct: 5.5 }, 5.5).aceitavel).toBe(true);
  });

  it("saldo que não parcela cai no à vista", () => {
    expect(melhorParceladoPossivel({ ...MIA, saldoCents: 6_000 }, POLITICA_PADRAO, HOJE).forma).toBe("a_vista");
  });

  it("propostaRespeitaPolitica pega proposta adulterada", () => {
    const boa = propostaAVista(MIA, POLITICA_PADRAO, HOJE);
    expect(propostaRespeitaPolitica(MIA, POLITICA_PADRAO, HOJE, boa)).toEqual({ ok: true });
    expect(
      propostaRespeitaPolitica(MIA, POLITICA_PADRAO, HOJE, { ...boa, totalCents: 100_000 }),
    ).toEqual({ ok: false, motivo: "desconto_acima_do_maximo" });
    const parc = melhorParceladoPossivel(MIA, POLITICA_PADRAO, HOJE);
    expect(propostaRespeitaPolitica(MIA, POLITICA_PADRAO, HOJE, parc)).toEqual({ ok: true });
    expect(
      propostaRespeitaPolitica(MIA, POLITICA_PADRAO, HOJE, { ...parc, parcelas: 24 }),
    ).toEqual({ ok: false, motivo: "parcelas_acima_do_maximo" });
  });
});
