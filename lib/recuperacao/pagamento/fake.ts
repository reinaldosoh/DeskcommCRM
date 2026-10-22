/**
 * Provedor FAKE — período de validação (decisão do Reinaldo, 20/10/2026).
 *
 * Gera PIX copia-e-cola num formato válido, mas com chave num domínio
 * `.invalid` (nenhum banco aceita), e um "boleto" em texto com banco 000 e o
 * aviso de teste no topo. Nada aqui movimenta dinheiro.
 */
import { formatCentsBRL } from "@/lib/money";

import { montarBrCode } from "./br-code";
import type { CobrancaGerada, PedidoDeCobranca, ProvedorDePagamento } from "./tipos";

export const CHAVE_PIX_FAKE = "teste@ruios.invalid";

function txidDe(p: PedidoDeCobranca): string {
  return `TESTE${p.acordoId.replace(/-/g, "").slice(0, 14)}P${p.parcela}`.toUpperCase();
}

/** Módulo 10 do boleto (campos da linha digitável). */
function mod10(numeros: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = numeros.length - 1; i >= 0; i--) {
    let r = Number(numeros[i]) * peso;
    if (r > 9) r = Math.floor(r / 10) + (r % 10);
    soma += r;
    peso = peso === 2 ? 1 : 2;
  }
  return (10 - (soma % 10)) % 10;
}

function linhaDigitavelFake(p: PedidoDeCobranca): string {
  // Banco 000 não existe: a linha tem a forma de boleto, mas não é pagável.
  const nosso = (p.acordoId.replace(/\D/g, "") + "0000000000").slice(0, 10) + String(p.parcela).padStart(2, "0");
  const c1 = `0009${nosso.slice(0, 5)}`;
  const c2 = `${nosso.slice(5)}000`.padEnd(10, "0").slice(0, 10);
  const c3 = "0000000000";
  const valor = String(p.valorCents).padStart(10, "0");
  return `${c1}${mod10(c1)} ${c2}${mod10(c2)} ${c3}${mod10(c3)} 0 0000${valor}`;
}

export class ProvedorFake implements ProvedorDePagamento {
  readonly nome = "fake";

  async gerarPix(p: PedidoDeCobranca): Promise<CobrancaGerada> {
    const txid = txidDe(p);
    return {
      provedor: this.nome,
      idExterno: `fake-pix-${txid}`,
      teste: true,
      pix: {
        txid,
        copiaECola: montarBrCode({
          chave: CHAVE_PIX_FAKE,
          valorCents: p.valorCents,
          nomeRecebedor: "RUIOS TESTE",
          cidade: "SAO PAULO",
          txid,
        }),
      },
    };
  }

  async gerarBoleto(p: PedidoDeCobranca): Promise<CobrancaGerada> {
    const linha = linhaDigitavelFake(p);
    const conteudo = [
      "*** BOLETO DE TESTE — NÃO PAGUE — SEM VALOR ***",
      "",
      `Pagador: ${p.devedorNome}`,
      `Referente a: ${p.descricao} (parcela ${p.parcela})`,
      `Valor: ${formatCentsBRL(p.valorCents)}`,
      `Vencimento: ${p.vencimento}`,
      "",
      `Linha digitável: ${linha}`,
      "",
      "Gerado pelo período de validação da Ruios. Nenhum banco reconhece este documento.",
    ].join("\n");
    return {
      provedor: this.nome,
      idExterno: `fake-boleto-${txidDe(p)}`,
      teste: true,
      boleto: {
        linhaDigitavel: linha,
        arquivoNome: `boleto-TESTE-${p.acordoId.slice(0, 8)}-p${p.parcela}.txt`,
        arquivoConteudo: conteudo,
        mime: "text/plain",
      },
    };
  }
}

/**
 * O provedor em uso. Só existe o fake por enquanto; o Pixxifeito entra aqui
 * quando a integração existir, escolhido pela configuração da organização.
 */
export function provedorDePagamento(): ProvedorDePagamento {
  return new ProvedorFake();
}
