/**
 * O RETORNO combinado: quando chega o `retornar_em`, a agente volta a falar com
 * a pessoa — e volta lembrando. O histórico não é enfeite: o que a pessoa
 * contou (`contexto_do_retorno`) é o que faz a mensagem ser "e aí, aquilo
 * melhorou?" em vez de começar do zero.
 *
 * Puro: decide se o retorno está vencido e monta a nota de contexto que entra
 * na vez da agente. Quem dispara (o simulador hoje; a régua em produção) é
 * quem chama.
 */
import { identidadeVigente, VALIDADE_DA_IDENTIDADE_DIAS } from "./identidade";
import type { DividaRow } from "./repositorio";

type Linha = Pick<
  DividaRow,
  "retornar_em" | "contexto_do_retorno" | "identidade_verificada_em" | "opt_out_em" | "cuidado_em" | "status"
>;

/** Há retorno a fazer agora? Nunca depois de opt-out nem de sinal de risco (aí quem retoma é gente). */
export function retornoVencido(d: Linha, agora: Date): boolean {
  if (!d.retornar_em || d.opt_out_em || d.cuidado_em) return false;
  if (d.status !== "aberta") return false;
  return new Date(d.retornar_em).getTime() <= agora.getTime();
}

/** dd/mm/aaaa no calendário de Brasília (vai para o modelo, não para a tela: não segue o idioma da UI). */
function dataBR(iso: string | Date): string {
  const [a, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(iso)).split("-");
  return `${d}/${m}/${a}`;
}

/**
 * A nota que a agente recebe na vez do retorno: há quanto tempo, o que a
 * pessoa contou, e se a identidade ainda vale (90 dias no mesmo número).
 */
export function notaDoRetorno(d: Linha, agora: Date, ultimaConversaEm: string | null): string {
  const dias = ultimaConversaEm
    ? Math.max(1, Math.round((agora.getTime() - new Date(ultimaConversaEm).getTime()) / 86_400_000))
    : null;
  const vigente = identidadeVigente(d.identidade_verificada_em, agora);
  const linhas = [
    `[sistema] RETORNO COMBINADO. Hoje é ${dataBR(agora)}` +
      (dias ? `; a última conversa com esta pessoa foi há ${dias} dia(s)` : "") +
      ". É você quem está retomando o contato, como combinado.",
    d.contexto_do_retorno
      ? `O que ela contou da outra vez: ${d.contexto_do_retorno}`
      : "Não ficou registrado o motivo da outra vez: use o histórico acima.",
  ];
  if (vigente && d.identidade_verificada_em) {
    linhas.push(
      `A identidade já foi confirmada em ${dataBR(d.identidade_verificada_em)} (vale ${VALIDADE_DA_IDENTIDADE_DIAS} dias): ` +
        "NÃO peça o CPF de novo. Abra pelo primeiro nome, lembre com carinho do que ela contou e pergunte se " +
        "aquilo melhorou, ANTES de falar da pendência. Depois, pergunte se dá para retomar e consulte a dívida " +
        "de novo (valores e datas mudam com o tempo).",
    );
  } else {
    linhas.push(
      "A confirmação de identidade expirou: abra só com nome e o assunto (pendência com o credor) e peça os 3 " +
        "primeiros dígitos do CPF. Só depois de confirmar, lembre do que ela contou — antes disso, quem está " +
        "do outro lado pode não ser ela.",
    );
  }
  return linhas.join("\n");
}
