/**
 * BR Code (PIX copia-e-cola) no padrão EMV-MPM do Banco Central. Usado pelo
 * provedor fake — o formato é o real, a chave é que não existe.
 */

function campo(id: string, valor: string): string {
  return `${id}${String(valor.length).padStart(2, "0")}${valor}`;
}

/** CRC16-CCITT (poly 0x1021, init 0xFFFF), como o BR Code exige. */
export function crc16(texto: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(texto, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function semAcento(texto: string, max: number): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .toUpperCase()
    .slice(0, max);
}

export function montarBrCode(p: {
  chave: string;
  valorCents: number;
  nomeRecebedor: string;
  cidade: string;
  txid: string;
}): string {
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", p.chave);
  const corpo =
    campo("00", "01") +
    campo("26", conta) +
    campo("52", "0000") +
    campo("53", "986") +
    campo("54", (p.valorCents / 100).toFixed(2)) +
    campo("58", "BR") +
    campo("59", semAcento(p.nomeRecebedor, 25)) +
    campo("60", semAcento(p.cidade, 15)) +
    campo("62", campo("05", semAcento(p.txid, 25).replace(/ /g, "")));
  const semCrc = `${corpo}6304`;
  return semCrc + crc16(semCrc);
}
