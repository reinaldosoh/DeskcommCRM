/**
 * Sinal de RISCO À VIDA numa conversa de cobrança: o que a agente passa para
 * a pessoa e onde. A cobrança para (`cuidado_em` na dívida) e só um humano
 * libera; aqui só se decide QUAIS contatos de ajuda mostrar.
 *
 * Regra de ouro: a agente nunca inventa telefone nem endereço. Os contatos
 * nacionais abaixo valem em todo o Brasil; os locais (CAPS, pronto-socorro de
 * referência) só entram quando alguém da operação conferiu o número e o
 * cadastrou em `RECURSOS_LOCAIS`. Sem cadastro, a orientação local é genérica
 * ("o CAPS ou a UPA mais perto de você"), com o nome da cidade.
 */

export interface RecursoDeAjuda {
  nome: string;
  contato: string;
  quando: string;
}

/** Valem no país inteiro, 24 horas, de graça. */
export const RECURSOS_NACIONAIS: readonly RecursoDeAjuda[] = [
  { nome: "CVV (Centro de Valorização da Vida)", contato: "ligue 188 ou converse pelo chat em cvv.org.br", quando: "para conversar, a qualquer hora" },
  { nome: "SAMU", contato: "ligue 192", quando: "se a pessoa já se machucou, tomou algo ou corre risco agora" },
];

/**
 * Contatos locais CONFERIDOS, por "UF" ou "UF:Cidade" (cidade como no cadastro).
 * Só entra aqui número verificado por gente da operação, com a data da
 * conferência — número de saúde desatualizado é pior que nenhum.
 */
export const RECURSOS_LOCAIS: Readonly<Record<string, readonly (RecursoDeAjuda & { conferidoEm: string })[]>> = {};

function chave(uf: string | null, cidade: string | null): string[] {
  const u = (uf ?? "").trim().toUpperCase();
  const c = (cidade ?? "").trim();
  return [u && c ? `${u}:${c}` : "", u].filter(Boolean);
}

export function recursosDeAjuda(cidade: string | null, uf: string | null) {
  const locais = chave(uf, cidade).flatMap((k) => RECURSOS_LOCAIS[k] ?? []);
  const onde = cidade ? `${cidade}${uf ? `/${uf.toUpperCase()}` : ""}` : null;
  return {
    cidade: onde,
    nacionais: RECURSOS_NACIONAIS,
    locais: locais.map(({ nome, contato, quando }) => ({ nome, contato, quando })),
    orientacao_local: onde
      ? `Em ${onde}, a pessoa também pode procurar o CAPS ou a UPA/pronto-socorro mais perto de casa.`
      : "A pessoa também pode procurar o CAPS ou a UPA/pronto-socorro mais perto de casa.",
  };
}
