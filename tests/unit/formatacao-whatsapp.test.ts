import { describe, expect, it } from "vitest";

import { markdownParaWhatsapp, temMarkdownCru } from "@/lib/agent-engine/texto/formatacao-whatsapp";

describe("Markdown → WhatsApp", () => {
  it("negrito de Markdown vira o negrito do WhatsApp (caso real da Bella)", () => {
    const real =
      "Quando você diz que não sabe por que continuar vivendo, fico preocupada: **você está pensando em se machucar? Está sozinho?**\n\n" +
      "Ligue para o **CVV, no 188**.";
    const saida = markdownParaWhatsapp(real);
    expect(saida).toContain("*você está pensando em se machucar? Está sozinho?*");
    expect(saida).toContain("*CVV, no 188*");
    expect(saida).not.toContain("**");
    expect(temMarkdownCru(real)).toBe(true);
    expect(temMarkdownCru(saida)).toBe(false);
  });

  it("itálico, tachado, títulos, listas e links", () => {
    expect(markdownParaWhatsapp("__forte__ e ~~velho~~")).toBe("*forte* e ~velho~");
    expect(markdownParaWhatsapp("## Seu acordo\n- entrada\n* parcelas")).toBe("*Seu acordo*\n• entrada\n• parcelas");
    expect(markdownParaWhatsapp("veja [o site](https://ruios.com.br/x)")).toBe("veja o site: https://ruios.com.br/x");
    expect(markdownParaWhatsapp("***muito***")).toBe("*muito*");
  });

  it("não mexe no que o WhatsApp já entende nem em código de pagamento", () => {
    const ok = "*Fechado!* Pague até _26/10_.\n\n00020126580014BR.GOV.BCB.PIX0136a1b2c3d4-e5f6__teste__**x**5204000053039865802BR";
    expect(markdownParaWhatsapp(ok)).toBe(ok);
    expect(markdownParaWhatsapp("R$ 3.581,27 à vista (5% de desconto)")).toBe("R$ 3.581,27 à vista (5% de desconto)");
    expect(markdownParaWhatsapp("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(temMarkdownCru(ok)).toBe(false);
  });
});
