/**
 * Markdown → formatação do WhatsApp.
 *
 * O modelo escreve Markdown por hábito (`**negrito**`, `# título`, `- item`),
 * e no WhatsApp isso chega cru: o negrito de lá é `*um asterisco*`, o itálico é
 * `_sublinhado_` e o tachado é `~til~`. Esta conversão é determinística e roda
 * no texto escrito pela IA antes de sair — não é preferência de estilo da
 * organização, é o formato do canal.
 *
 * Fica de fora o que o WhatsApp já entende (`*x*`, `_x_`, `~x~`, ```bloco```)
 * e o que não é formatação: um PIX copia-e-cola ou link nunca é alterado.
 */

/** Trechos que não podem ser tocados: blocos de código, código inline, URLs e tokens longos (PIX, linha digitável). */
const INTOCAVEL = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|\S{40,}/g;

function converterTrecho(t: string): string {
  return (
    t
      // **negrito** e __negrito__ → *negrito*
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "*$1*")
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=[^\w]|$)/g, "$1*$2*")
      // ~~tachado~~ → ~tachado~
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "~$1~")
      // # Título → *Título* (linha inteira em negrito)
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*")
      // - item / * item / + item → • item
      .replace(/^([ \t]*)[-*+][ \t]+(?=\S)/gm, "$1• ")
      // negrito duplicado que sobrou de `***x***` → *x*
      .replace(/\*{2,}(?=\S)([^*\n]+?)\*{2,}/g, "*$1*")
  );
}

export function markdownParaWhatsapp(textoDoModelo: string): string {
  // [texto](https://link) → texto: https://link — antes de separar as URLs intocáveis.
  const texto = textoDoModelo.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2");
  let saida = "";
  let ultimo = 0;
  for (const m of texto.matchAll(INTOCAVEL)) {
    saida += converterTrecho(texto.slice(ultimo, m.index));
    saida += m[0];
    ultimo = m.index + m[0].length;
  }
  return saida + converterTrecho(texto.slice(ultimo));
}

/** Sobrou marcação de Markdown que o WhatsApp mostra crua? (para auditoria) */
export function temMarkdownCru(texto: string): boolean {
  const semIntocavel = texto.replace(INTOCAVEL, " ");
  return (
    /\*\*\S/.test(semIntocavel) ||
    /~~\S/.test(semIntocavel) ||
    /^[ \t]{0,3}#{1,6}[ \t]+\S/m.test(semIntocavel) ||
    /\[[^\]\n]+\]\(https?:/.test(texto)
  );
}
