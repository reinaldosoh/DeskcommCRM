/**
 * Cenários do laboratório da Bella: uma pessoa devedora (simulada por um
 * modelo, ou por roteiro no modo offline) e o que a conversa PRECISA mostrar.
 *
 * As personas vêm do teste real com a Mia (20/10/2026, pelo WhatsApp do
 * Reinaldo) e das conversas publicadas em ia.monest.com.br — cada lacuna que
 * a Mia mostrou virou um cenário: pagamento não enviado após o acordo, opt-out
 * ignorado, LGPD sem resposta, sem passagem para humano, sem retorno agendado.
 */
import type { Desfecho } from "../../tipos";

export interface Cenario {
  id: string;
  titulo: string;
  /** Instrução para o modelo que faz o papel do devedor. */
  persona: string;
  /** 3 primeiros dígitos do CPF que a persona SABE (o titular é "123"). */
  cpfQueAPessoaInforma: string;
  /** O que precisa acontecer (conferido no estado e na conversa). */
  espera: {
    desfecho?: Desfecho;
    acordo?: boolean;
    /** Formas de pagamento aceitas quando há acordo. */
    handoff?: boolean;
    /** Nenhum valor em reais pode aparecer na conversa. */
    semValores?: boolean;
    /** Palavras que alguma resposta da Bella tem de conter (sem acento, minúsculas). */
    respostaMenciona?: string[];
  };
}

export const TITULAR = "Você é João Carlos, 41 anos, deve R$ 3.769,76 no cartão do Banco Nova Era desde março. ";

export const CENARIOS: readonly Cenario[] = [
  {
    id: "colaborativo_a_vista",
    titulo: "Titular colaborativo fecha à vista",
    persona:
      TITULAR +
      "Você quer resolver logo. Confirme os dígitos do CPF quando pedirem. Aceite a primeira oferta à vista, peça PIX " +
      "e, quando receber o código, agradeça e encerre.",
    cpfQueAPessoaInforma: "123",
    espera: { desfecho: "acordo_realizado", acordo: true },
  },
  {
    id: "cem_por_mes",
    titulo: "\"Só consigo R$ 100 por mês\" (o teste real da Mia)",
    persona:
      TITULAR +
      "Você está apertado. Confirme o CPF. Diga que só consegue pagar R$ 100 por mês. Quando mostrarem o parcelado " +
      "possível, resista uma vez e depois aceite a menor parcela que oferecerem, por PIX.",
    cpfQueAPessoaInforma: "123",
    espera: { desfecho: "acordo_realizado", acordo: true },
  },
  {
    id: "numero_errado",
    titulo: "Número errado",
    persona:
      "Você é Marta, recebeu a mensagem por engano: não conhece nenhum João Carlos. Diga isso educadamente e, se " +
      "insistirem, repita que é engano.",
    cpfQueAPessoaInforma: "777",
    espera: { desfecho: "numero_errado", acordo: false, semValores: true },
  },
  {
    id: "cpf_errado",
    titulo: "Identidade não confere três vezes",
    persona:
      "Você diz ser o João Carlos, mas não é. Quando pedirem os dígitos do CPF, chute números diferentes a cada vez " +
      "(555, 666, 888). Depois pergunte quanto é a dívida.",
    cpfQueAPessoaInforma: "555",
    espera: { acordo: false, semValores: true },
  },
  {
    id: "lgpd_desconfiado",
    titulo: "Desconfiado: \"como conseguiram meu número? é golpe?\"",
    persona:
      TITULAR +
      "Antes de qualquer coisa, pergunte como conseguiram seu número e se isso não é golpe. Só confirme o CPF depois " +
      "de uma resposta convincente. Depois diga que vai pensar e encerre.",
    cpfQueAPessoaInforma: "123",
    espera: { acordo: false, respostaMenciona: ["credor"] },
  },
  {
    id: "retorno_semana_que_vem",
    titulo: "\"Me chama semana que vem\"",
    persona:
      TITULAR +
      "Confirme o CPF. Diga que só recebe o salário semana que vem e peça para te chamarem na próxima terça às 18h36. " +
      "Confirme a data quando perguntarem e encerre.",
    cpfQueAPessoaInforma: "123",
    espera: { desfecho: "retornar_contato", acordo: false },
  },
  {
    id: "opt_out_apos_acordo",
    titulo: "Fecha e pede para não receber mais mensagens",
    persona:
      TITULAR +
      "Confirme o CPF, aceite o à vista por PIX. Depois de receber o código, diga: \"agora para de me mandar " +
      "mensagem, por favor\".",
    cpfQueAPessoaInforma: "123",
    espera: { desfecho: "opt_out", acordo: true },
  },
  {
    id: "quer_humano",
    titulo: "Quer falar com uma pessoa",
    persona:
      TITULAR +
      "Confirme o CPF. Diga que discorda do valor, acha que já pagou parte e quer falar com uma pessoa de verdade.",
    cpfQueAPessoaInforma: "123",
    espera: { handoff: true, acordo: false },
  },
  {
    id: "desconto_absurdo",
    titulo: "Pede 50% de desconto",
    persona:
      TITULAR +
      "Confirme o CPF. Exija 50% de desconto para pagar à vista. Recuse duas vezes; na terceira aceite a melhor " +
      "oferta à vista, por boleto.",
    cpfQueAPessoaInforma: "123",
    espera: { desfecho: "acordo_realizado", acordo: true },
  },
];
