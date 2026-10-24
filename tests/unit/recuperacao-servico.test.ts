/**
 * As operações da Bella contra o repositório em memória: identidade antes de
 * valor, só a dívida da conversa, acordo recalculado pela política e
 * pagamento gerado na hora.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { ProvedorFake } from "@/lib/recuperacao/pagamento/fake";
import { repositorioEmMemoria, type EstadoEmMemoria } from "@/lib/recuperacao/repositorio";
import { notaDoRetorno, retornoVencido } from "@/lib/recuperacao/retorno";
import {
  consultarDividas,
  fecharAcordo,
  hojeLocal,
  lerPolitica,
  pedirCondicaoMelhor,
  registrarCuidado,
  simularAcordo,
  tabular,
  verificarIdentidade,
  type ContextoDeCobranca,
} from "@/lib/recuperacao/servico";

const CONTATO = "c0000000-0000-4000-8000-000000000001";
const OUTRO = "c0000000-0000-4000-8000-000000000002";
const DIVIDA = "d0000000-0000-4000-8000-000000000001";
const DIVIDA_DO_OUTRO = "d0000000-0000-4000-8000-000000000002";

function novoEstado(): EstadoEmMemoria {
  const base = {
    carteira_id: "k1",
    produto: "cartão de crédito",
    vencimento_original: "2026-03-10",
    parcelas_vencidas: 4,
    status: "aberta" as const,
    identidade_tentativas: 0,
    identidade_verificada_em: null,
    identidade_bloqueada_ate: null,
    opt_out_em: null,
    retornar_em: null,
    desconto_liberado_pct: null,
    desconto_liberado_job: null,
    devedor_cidade: "Campinas",
    devedor_uf: "SP",
    contexto_do_retorno: null,
    cuidado_em: null,
  };
  return {
    carteiras: [
      { id: "k1", credor_nome: "Banco Nova Era", politica: {}, contato_hora_inicio: 8, contato_hora_fim: 20, contato_dias: [1, 2, 3, 4, 5, 6] },
    ],
    dividas: [
      { ...base, id: DIVIDA, contact_id: CONTATO, valor_devido_cents: 376_976, cpf_prefixo: "123" },
      { ...base, id: DIVIDA_DO_OUTRO, contact_id: OUTRO, valor_devido_cents: 99_999, cpf_prefixo: "456" },
    ],
    acordos: [],
    cobrancas: [],
    tabulacoes: [],
  };
}

let estado: EstadoEmMemoria;
let ctx: ContextoDeCobranca;
beforeEach(() => {
  estado = novoEstado();
  ctx = {
    repo: repositorioEmMemoria(estado),
    contatoId: CONTATO,
    agora: new Date("2026-10-20T15:00:00Z"),
    provedor: new ProvedorFake(),
    sourceJobId: "job-1",
  };
});

describe("antes da identidade", () => {
  it("consulta devolve só o credor, sem nenhum valor", async () => {
    const r = await consultarDividas(ctx);
    expect(r).toMatchObject({ permitido: false, motivo: "identidade_nao_confirmada", credores: ["Banco Nova Era"] });
    expect(JSON.stringify(r)).not.toMatch(/R\$|3769|376976/);
  });

  it("simular e fechar também recusam", async () => {
    expect(await simularAcordo(ctx, DIVIDA, { forma: "a_vista" })).toMatchObject({ motivo: "identidade_nao_confirmada" });
    expect(await fecharAcordo(ctx, DIVIDA, { forma: "a_vista" }, "pix", "João")).toMatchObject({
      motivo: "identidade_nao_confirmada",
    });
    expect(estado.acordos).toHaveLength(0);
  });
});

describe("identidade", () => {
  it("confirma, tabula uma vez só e libera a consulta", async () => {
    expect((await verificarIdentidade(ctx, "1 2 3")).status).toBe("verificado");
    expect((await verificarIdentidade(ctx, "123")).status).toBe("verificado");
    expect(estado.tabulacoes.filter((t) => t.desfecho === "identidade_confirmada")).toHaveLength(1);
    const r = await consultarDividas(ctx);
    expect(r.permitido).toBe(true);
  });

  it("bloqueia depois de 3 erros", async () => {
    await verificarIdentidade(ctx, "999");
    await verificarIdentidade(ctx, "998");
    expect((await verificarIdentidade(ctx, "997")).status).toBe("bloqueado");
    expect((await verificarIdentidade(ctx, "123")).status).toBe("bloqueado");
  });

  it("dívida sem CPF cadastrado pede humano", async () => {
    estado.dividas[0]!.cpf_prefixo = null;
    expect((await verificarIdentidade(ctx, "123")).status).toBe("sem_cadastro");
  });
});

describe("depois da identidade", () => {
  beforeEach(async () => {
    await verificarIdentidade(ctx, "123");
  });

  it("a escada de ofertas vem pronta, em texto", async () => {
    const r = await consultarDividas(ctx);
    if (!r.permitido) throw new Error("devia permitir");
    const ofertas = r.dividas[0]!.ofertas;
    expect(ofertas.map((o) => o.texto)).toEqual([
      "R$ 3.581,27 à vista (5% de desconto), para pagar até 26/10/2026",
      expect.stringMatching(/^entrada de R\$ .* \+ 11x de R\$ /),
    ]);
    expect(JSON.stringify(r)).not.toContain("10%");
  });

  it("condição melhor: um degrau por run, com objeção, e o fechamento respeita o liberado", async () => {
    const id = (await consultarDividas(ctx) as { dividas: Array<{ divida_id: string }> }).dividas[0]!.divida_id;
    const fecharDez = () =>
      fecharAcordo(ctx, id, { forma: "a_vista", descontoPct: 10 }, "pix", "João");
    expect(await fecharDez()).toMatchObject({ permitido: false, motivo: "desconto_nao_liberado" });

    expect(await pedirCondicaoMelhor(ctx, id, { objecao: "valor_total", oQueAPessoaDisse: "" })).toMatchObject({
      permitido: false,
      motivo: "sem_objecao",
    });
    const r1 = { ...ctx, sourceJobId: "run-1" };
    const um = await pedirCondicaoMelhor(r1, id, { objecao: "valor_total", oQueAPessoaDisse: "achou caro" });
    expect(um).toMatchObject({ conseguiu: true, nova_oferta: { descontoPct: 5.5 } });
    expect((um as { nova_oferta: { texto: string } }).nova_oferta.texto).toContain("5,5% de desconto");
    expect(await pedirCondicaoMelhor(r1, id, { objecao: "valor_total", oQueAPessoaDisse: "ainda caro" })).toMatchObject({
      permitido: false,
      motivo: "um_degrau_por_vez",
    });
    const dois = await pedirCondicaoMelhor({ ...ctx, sourceJobId: "run-2" }, id, { objecao: "valor_total", oQueAPessoaDisse: "ainda caro" });
    expect(dois).toMatchObject({ conseguiu: true, nova_oferta: { descontoPct: 6 } });
    const cons = (await consultarDividas(ctx)) as { dividas: Array<{ ofertas: Array<{ descontoPct: number }> }> };
    expect(cons.dividas[0]!.ofertas[0]!.descontoPct).toBe(6);
    expect(await fecharAcordo(ctx, id, { forma: "a_vista", descontoPct: 6 }, "pix", "João")).toMatchObject({ permitido: true });
  });

  it("dívida de outra pessoa é fora_da_conversa", async () => {
    expect(await simularAcordo(ctx, DIVIDA_DO_OUTRO, { forma: "a_vista" })).toMatchObject({ motivo: "fora_da_conversa" });
    expect(await fecharAcordo(ctx, DIVIDA_DO_OUTRO, { forma: "a_vista" }, "pix", "x")).toMatchObject({
      motivo: "fora_da_conversa",
    });
    expect(await tabular(ctx, { dividaId: DIVIDA_DO_OUTRO, desfecho: "opt_out" })).toMatchObject({ motivo: "fora_da_conversa" });
  });

  it("fecha o acordo da Mia e gera o PIX de teste na hora", async () => {
    const r = await fecharAcordo(ctx, DIVIDA, { forma: "parcelado", parcelas: 12, entradaCents: 20_004 }, "pix", "João");
    expect(r).toMatchObject({ permitido: true, pagamento: { meio: "pix", valor: "R$ 200,04", teste: true } });
    expect(estado.acordos[0]).toMatchObject({ entrada_cents: 20_004, parcela_cents: 32_452, parcelas: 12, source_job_id: "job-1" });
    expect(estado.cobrancas[0]).toMatchObject({ parcela: 1, valor_cents: 20_004, teste: true });
    expect(estado.dividas[0]!.status).toBe("em_acordo");
    expect(estado.tabulacoes.at(-1)?.desfecho).toBe("acordo_realizado");
    // Segundo "fechado" não duplica.
    expect(await fecharAcordo(ctx, DIVIDA, { forma: "a_vista" }, "pix", "João")).toMatchObject({ motivo: "acordo_ja_existe" });
    expect(estado.acordos).toHaveLength(1);
  });

  it("pedido fora da política não fecha: volta contraproposta", async () => {
    const r = await fecharAcordo(ctx, DIVIDA, { forma: "a_vista", totalDesejadoCents: 100_000 }, "boleto", "João");
    expect(r).toMatchObject({ permitido: false, motivo: "valor_abaixo_do_permitido" });
    expect(estado.acordos).toHaveLength(0);
  });

  it("total diferente do aceito não fecha: devolve a condição para novo aceite", async () => {
    const r = await fecharAcordo(ctx, DIVIDA, { forma: "a_vista" }, "pix", "João", 1);
    expect(r).toMatchObject({ permitido: false, motivo: "difere_do_aceito" });
    expect((r as { proposta?: { texto?: string } }).proposta?.texto).toContain("à vista");
    expect(estado.acordos).toHaveLength(0);
    const total = (r as { proposta: { totalCents: number } }).proposta.totalCents;
    expect(await fecharAcordo(ctx, DIVIDA, { forma: "a_vista" }, "pix", "João", total + 50)).toMatchObject({ permitido: true });
  });

  it("boleto gera linha digitável de teste", async () => {
    const r = (await fecharAcordo(ctx, DIVIDA, { forma: "a_vista", descontoPct: 5 }, "boleto", "João")) as {
      pagamento?: { boleto_linha_digitavel?: string };
    };
    expect(r.pagamento?.boleto_linha_digitavel).toMatch(/^0009/);
  });
});

describe("tabulação", () => {
  it("opt-out marca todas as dívidas da pessoa e limpa retorno", async () => {
    await tabular(ctx, { desfecho: "retornar_contato", retornarEm: "2026-10-27T18:36:00-03:00" });
    expect(estado.dividas[0]!.retornar_em).toBe("2026-10-27T18:36:00-03:00");
    await tabular(ctx, { desfecho: "opt_out" });
    expect(estado.dividas[0]!.opt_out_em).not.toBeNull();
    expect(estado.dividas[0]!.retornar_em).toBeNull();
    expect(estado.dividas[1]!.opt_out_em).toBeNull();
  });

  it("retornar sem data é recusado", async () => {
    expect(await tabular(ctx, { desfecho: "retornar_contato" })).toMatchObject({ motivo: "retorno_sem_data" });
  });
});

describe("utilidades", () => {
  it("hoje é o dia de São Paulo, não o de UTC", () => {
    expect(hojeLocal(new Date("2026-10-21T01:00:00Z")).toISOString().slice(0, 10)).toBe("2026-10-20");
  });

  it("política inválida é erro, não chute", () => {
    expect(() => lerPolitica({ maxParcelas: -1 })).toThrow(/politica_invalida/);
    expect(lerPolitica({ maxParcelas: 6 }).maxParcelas).toBe(6);
  });
});

describe("cuidado, identidade de 90 dias e memória do retorno", () => {
  it("sinal de risco pausa toda a cobrança, traz a ajuda da cidade e barra o retorno automático", async () => {
    await verificarIdentidade(ctx, "123");
    await tabular(ctx, { desfecho: "retornar_contato", retornarEm: "2026-11-06T10:00:00-03:00" });
    const r = await registrarCuidado(ctx, "não vê sentido em viver");
    expect(r).toMatchObject({ permitido: true, cobranca_pausada: true, ajuda: { cidade: "Campinas/SP" } });
    expect(JSON.stringify(r.ajuda)).toContain("188");
    expect(r.ajuda.orientacao_local).toContain("Campinas/SP");
    expect(estado.dividas[0]!.cuidado_em).not.toBeNull();
    expect(estado.dividas[0]!.retornar_em).toBeNull();
    expect(await consultarDividas(ctx)).toMatchObject({ permitido: false, motivo: "cobranca_pausada_por_cuidado" });
    expect(await simularAcordo(ctx, DIVIDA, { forma: "a_vista" })).toMatchObject({ motivo: "cobranca_pausada_por_cuidado" });
    expect(
      await tabular(ctx, { desfecho: "retornar_contato", retornarEm: "2026-12-01T10:00:00-03:00" }),
    ).toMatchObject({ motivo: "cobranca_pausada_por_cuidado" });
  });

  it("identidade vale 90 dias: dentro não pede de novo, depois volta a pedir", async () => {
    await verificarIdentidade(ctx, "123");
    const em80 = { ...ctx, agora: new Date(ctx.agora.getTime() + 80 * 86_400_000) };
    expect(await consultarDividas(em80)).toMatchObject({ permitido: true });
    const em95 = { ...ctx, agora: new Date(ctx.agora.getTime() + 95 * 86_400_000) };
    expect(await consultarDividas(em95)).toMatchObject({ permitido: false, motivo: "identidade_nao_confirmada" });
    expect(await verificarIdentidade(em95, "999")).toMatchObject({ status: "nao_confere" });
    expect(await verificarIdentidade(em95, "123")).toMatchObject({ status: "verificado" });
    expect(await consultarDividas(em95)).toMatchObject({ permitido: true });
  });

  it("o retorno guarda o que a pessoa contou e a nota lembra disso, sem pedir CPF", async () => {
    await verificarIdentidade(ctx, "123");
    await tabular(ctx, {
      dividaId: DIVIDA,
      desfecho: "retornar_contato",
      retornarEm: "2026-11-09T10:00:00-03:00",
      contexto: "perdeu a mãe e o emprego; espera receber um valor em janeiro",
    });
    const d = estado.dividas[0]!;
    expect(d.contexto_do_retorno).toBe("perdeu a mãe e o emprego; espera receber um valor em janeiro");
    expect(retornoVencido(d, new Date("2026-11-08T12:00:00-03:00"))).toBe(false);
    const quando = new Date("2026-11-09T10:00:00-03:00");
    expect(retornoVencido(d, quando)).toBe(true);
    const nota = notaDoRetorno(d, quando, ctx.agora.toISOString());
    expect(nota).toContain("perdeu a mãe e o emprego");
    expect(nota).toContain("NÃO peça o CPF de novo");
    // Passou de 90 dias: a nota manda confirmar antes de lembrar de qualquer coisa pessoal.
    expect(notaDoRetorno(d, new Date("2027-03-01T10:00:00-03:00"), null)).toContain("expirou");
  });
});
