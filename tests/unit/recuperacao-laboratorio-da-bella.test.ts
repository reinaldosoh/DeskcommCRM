/**
 * O laboratório da Bella, modo offline, no CI: cada cenário roteirizado passa
 * pelas ferramentas, serviço e guardrail de verdade e precisa ser aprovado pelo
 * juiz determinístico — e o juiz precisa REPROVAR a conversa da Mia.
 */
import { describe, expect, it } from "vitest";

import { validatePlaybookLayerContent } from "@/lib/agent-engine/agent/playbook";
import { FERRAMENTAS_DA_BELLA, playbookDaBella } from "@/lib/recuperacao/bella/definicao";
import { CENARIOS } from "@/lib/recuperacao/bella/lab/cenarios";
import { conferir, passou } from "@/lib/recuperacao/bella/lab/conferencia";
import { ROTEIROS, ROTEIRO_DA_MIA, cenarioPorId, executarRoteiro } from "@/lib/recuperacao/bella/lab/roteiros";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalogo";

describe("laboratório da Bella (offline)", () => {
  for (const cenario of CENARIOS) {
    it(cenario.titulo, async () => {
      const roteiro = ROTEIROS[cenario.id];
      expect(roteiro, `cenário ${cenario.id} sem roteiro offline`).toBeDefined();
      const amb = await executarRoteiro(roteiro!);
      const reprovados = conferir(cenario, amb).filter((c) => !c.ok);
      expect(reprovados).toEqual([]);
    });
  }

  it("o guardrail pega o desconto acima do teto e a Bella reescreve", async () => {
    const amb = await executarRoteiro(ROTEIROS.desconto_absurdo!);
    expect(amb.vetos).toEqual(["cobranca_acima_da_politica"]);
    expect(amb.conversa.some((m) => m.vetos.includes("cobranca_acima_da_politica"))).toBe(true);
  });

  it("controle negativo: fechar sem mandar o pagamento (como a Mia) é reprovado", async () => {
    const amb = await executarRoteiro(ROTEIRO_DA_MIA);
    const criterios = conferir(cenarioPorId("colaborativo_a_vista"), amb);
    expect(passou(criterios)).toBe(false);
    expect(criterios.find((c) => c.nome.startsWith("mandou o código"))?.ok).toBe(false);
  });

  it("o playbook cabe numa camada e só cita ferramentas que existem", () => {
    const texto = playbookDaBella();
    expect(() => validatePlaybookLayerContent(texto)).not.toThrow();
    for (const nome of FERRAMENTAS_DA_BELLA) expect(VALID_TOOL_IDS).toContain(nome);
    const citadas = [...texto.matchAll(/`((?:cobranca|crm)_[a-z_]+)`/g)].map((m) => m[1]!);
    for (const nome of citadas) expect(FERRAMENTAS_DA_BELLA as readonly string[]).toContain(nome);
  });
});

describe("rascunho da Bella", () => {
  it("passa na validação de criação de agente", async () => {
    const { agentMcpCreateSchema } = await import("@/lib/ai/agents/validation");
    const { rascunhoDaBella } = await import("@/lib/recuperacao/bella/definicao");
    const r = agentMcpCreateSchema.safeParse(rascunhoDaBella());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});
