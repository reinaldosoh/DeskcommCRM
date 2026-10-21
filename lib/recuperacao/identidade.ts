/**
 * Confirmação de identidade antes de qualquer valor — o mesmo gesto da Mia
 * ("me confirma os 3 primeiros dígitos do seu CPF"), com o que faltava nela:
 * limite de tentativas e bloqueio temporário, para o número errado não virar
 * um jogo de adivinhação de CPF.
 *
 * Puro: quem guarda o estado é a tabela `recuperacao_identidades`; aqui só
 * se decide.
 */

export const DIGITOS_CONFERIDOS = 3;
export const MAX_TENTATIVAS = 3;
export const BLOQUEIO_MINUTOS = 60;

export function somenteDigitos(texto: string): string {
  return texto.replace(/\D/g, "");
}

export type Conferencia = "confere" | "nao_confere" | "resposta_invalida";

/**
 * Compara a resposta do devedor com o CPF cadastrado. Aceita "157", "1 5 7",
 * "157.xxx" e o CPF inteiro — só os primeiros dígitos contam. Nunca devolve o
 * CPF cadastrado nem diz QUAL dígito errou.
 */
export function conferirPrefixoCpf(
  cpfCadastrado: string,
  resposta: string,
  digitos: number = DIGITOS_CONFERIDOS,
): Conferencia {
  const esperado = somenteDigitos(cpfCadastrado).slice(0, digitos);
  const informado = somenteDigitos(resposta).slice(0, digitos);
  if (esperado.length < digitos) return "resposta_invalida";
  if (informado.length < digitos) return "resposta_invalida";
  return informado === esperado ? "confere" : "nao_confere";
}

export interface EstadoDeIdentidade {
  tentativas: number;
  verificadoEm: string | null;
  bloqueadoAte: string | null;
}

export const ESTADO_INICIAL: EstadoDeIdentidade = { tentativas: 0, verificadoEm: null, bloqueadoAte: null };

export function estaBloqueado(estado: EstadoDeIdentidade, agora: Date): boolean {
  return estado.bloqueadoAte !== null && new Date(estado.bloqueadoAte).getTime() > agora.getTime();
}

export type ResultadoDaTentativa =
  | { status: "verificado"; estado: EstadoDeIdentidade }
  | { status: "nao_confere"; restantes: number; estado: EstadoDeIdentidade }
  | { status: "resposta_invalida"; estado: EstadoDeIdentidade }
  | { status: "bloqueado"; ate: string; estado: EstadoDeIdentidade };

/** Aplica uma tentativa ao estado. Resposta ilegível NÃO gasta tentativa. */
export function registrarTentativa(
  estado: EstadoDeIdentidade,
  cpfCadastrado: string,
  resposta: string,
  agora: Date,
): ResultadoDaTentativa {
  if (estado.verificadoEm) return { status: "verificado", estado };
  if (estaBloqueado(estado, agora)) return { status: "bloqueado", ate: estado.bloqueadoAte!, estado };

  // Bloqueio vencido: recomeça a contagem.
  const base = estado.bloqueadoAte ? { ...ESTADO_INICIAL } : estado;
  const c = conferirPrefixoCpf(cpfCadastrado, resposta);
  if (c === "resposta_invalida") return { status: "resposta_invalida", estado: base };
  if (c === "confere") {
    return { status: "verificado", estado: { ...base, verificadoEm: agora.toISOString(), bloqueadoAte: null } };
  }
  const tentativas = base.tentativas + 1;
  if (tentativas >= MAX_TENTATIVAS) {
    const ate = new Date(agora.getTime() + BLOQUEIO_MINUTOS * 60_000).toISOString();
    return { status: "bloqueado", ate, estado: { tentativas, verificadoEm: null, bloqueadoAte: ate } };
  }
  return {
    status: "nao_confere",
    restantes: MAX_TENTATIVAS - tentativas,
    estado: { ...base, tentativas },
  };
}
