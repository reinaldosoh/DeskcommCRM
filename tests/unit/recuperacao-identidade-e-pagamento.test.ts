import { describe, expect, it } from "vitest";

import {
  ESTADO_INICIAL,
  MAX_TENTATIVAS,
  conferirPrefixoCpf,
  registrarTentativa,
} from "@/lib/recuperacao/identidade";
import { crc16, montarBrCode } from "@/lib/recuperacao/pagamento/br-code";
import { CHAVE_PIX_FAKE, ProvedorFake } from "@/lib/recuperacao/pagamento/fake";

const CPF = "123.456.789-09";
const AGORA = new Date("2026-10-20T15:00:00Z");

describe("identidade por prefixo do CPF", () => {
  it("aceita os formatos que o devedor manda", () => {
    expect(conferirPrefixoCpf(CPF, "123")).toBe("confere");
    expect(conferirPrefixoCpf(CPF, "1 2 3")).toBe("confere");
    expect(conferirPrefixoCpf(CPF, "é 123.456")).toBe("confere");
    expect(conferirPrefixoCpf(CPF, "321")).toBe("nao_confere");
    expect(conferirPrefixoCpf(CPF, "sei não")).toBe("resposta_invalida");
    expect(conferirPrefixoCpf("", "123")).toBe("resposta_invalida");
  });

  it("bloqueia depois de 3 erros e libera depois do prazo", () => {
    let estado = ESTADO_INICIAL;
    for (let i = 1; i < MAX_TENTATIVAS; i++) {
      const r = registrarTentativa(estado, CPF, "999", AGORA);
      expect(r).toMatchObject({ status: "nao_confere", restantes: MAX_TENTATIVAS - i });
      estado = r.estado;
    }
    const bloq = registrarTentativa(estado, CPF, "999", AGORA);
    expect(bloq.status).toBe("bloqueado");
    // Nem a resposta certa passa durante o bloqueio.
    expect(registrarTentativa(bloq.estado, CPF, "123", AGORA).status).toBe("bloqueado");
    const depois = new Date(AGORA.getTime() + 61 * 60_000);
    expect(registrarTentativa(bloq.estado, CPF, "123", depois).status).toBe("verificado");
  });

  it("resposta ilegível não gasta tentativa", () => {
    const r = registrarTentativa(ESTADO_INICIAL, CPF, "oi?", AGORA);
    expect(r.status).toBe("resposta_invalida");
    expect(r.estado.tentativas).toBe(0);
  });
});

describe("pagamento fake", () => {
  it("CRC16 do BR Code bate com o vetor de referência", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("PIX copia-e-cola tem forma EMV válida, valor certo e chave inexistente", async () => {
    const c = await new ProvedorFake().gerarPix({
      acordoId: "6f1c2a9e-0000-4000-8000-000000000001",
      parcela: 1,
      valorCents: 20_004,
      vencimento: "2026-10-26",
      devedorNome: "João",
      descricao: "Acordo cartão",
    });
    expect(c.teste).toBe(true);
    const code = c.pix!.copiaECola;
    expect(code.startsWith("000201")).toBe(true);
    expect(code).toContain("5406200.04");
    expect(code).toContain(CHAVE_PIX_FAKE);
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
  });

  it("BR Code recalcula o CRC de forma estável", () => {
    const a = montarBrCode({ chave: "x@y.invalid", valorCents: 100, nomeRecebedor: "Ação", cidade: "São Paulo", txid: "T1" });
    expect(a).toContain("5904ACAO");
    expect(a.slice(-4)).toBe(crc16(a.slice(0, -4)));
  });

  it("boleto fake avisa que é teste e usa banco inexistente", async () => {
    const c = await new ProvedorFake().gerarBoleto({
      acordoId: "6f1c2a9e-0000-4000-8000-000000000001",
      parcela: 2,
      valorCents: 32_452,
      vencimento: "2026-11-26",
      devedorNome: "João",
      descricao: "Acordo cartão",
    });
    expect(c.boleto!.arquivoConteudo).toMatch(/TESTE/);
    expect(c.boleto!.linhaDigitavel.startsWith("0009")).toBe(true);
    expect(c.boleto!.linhaDigitavel).toMatch(/0000032452$/);
  });
});
