/**
 * Rodar conversas: uma (persona automática do começo ao fim) ou um LOTE de
 * dezenas/centenas, em paralelo, com auditoria e juiz em cada uma. Os lotes
 * ficam gravados em `.bella-sim/lotes/` para comparar rodadas (playbook antes
 * e depois de uma correção).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { playbookDaBella } from "../definicao";
import { AGORA_DO_LAB, DIVIDA_PADRAO, type DividaDoAmbiente, type Mensagem, type Chamada } from "../lab/ambiente";
import { SessaoBella, type TurnoDaBella, type Uso } from "../lab/motor";
import { aprovada, auditar, type Achado } from "./auditoria";
import { cenarioCaos, cenarioPorId, dividaAleatoria, type CenarioDoSimulador, type Grupo } from "./cenarios";
import { julgar, type Veredito } from "./juiz";

export const PASTA = path.join(process.cwd(), ".bella-sim");
const PASTA_LOTES = path.join(PASTA, "lotes");

export interface OpcoesDeRodada {
  modeloBella: string;
  modeloPersona: string;
  /** `null` desliga o juiz por modelo (fica só a auditoria determinística). */
  modeloJuiz: string | null;
  playbook?: string;
  maxTurnos: number;
  /** Data/hora simulada (ISO). Padrão: a do laboratório. */
  agora?: string;
}

export interface ResultadoDaConversa {
  n: number;
  status: "fila" | "rodando" | "aprovada" | "reprovada" | "erro" | "cancelada";
  cenario: { id: string; titulo: string; grupo: Grupo };
  divida: DividaDoAmbiente;
  conversa: Mensagem[];
  chamadas: Array<Pick<Chamada, "nome" | "args" | "resultado" | "posicao">>;
  turnos: Array<Pick<TurnoDaBella, "ms" | "travou" | "vetos" | "erro">>;
  achados: Achado[];
  juiz?: Veredito;
  desfechos: string[];
  acordo: boolean;
  handoff: boolean;
  uso: Uso;
  ms: number;
  erro?: string;
}

/** A hora da conversa: a base simulada, trocando a hora quando o cenário pede. */
export function agoraDaConversa(base: Date, hora?: number): Date {
  if (hora === undefined) return base;
  const dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(base);
  return new Date(`${dia}T${String(hora).padStart(2, "0")}:00:00-03:00`);
}

export function vazio(n: number, cenario: CenarioDoSimulador, divida: DividaDoAmbiente): ResultadoDaConversa {
  return {
    n,
    status: "fila",
    cenario: { id: cenario.id, titulo: cenario.titulo, grupo: cenario.grupo },
    divida,
    conversa: [],
    chamadas: [],
    turnos: [],
    achados: [],
    desfechos: [],
    acordo: false,
    handoff: false,
    uso: { entrada: 0, saida: 0, cache: 0 },
    ms: 0,
  };
}

/** Uma conversa inteira: Bella × persona, depois auditoria e juiz. `aoMudar` recebe o parcial a cada fala. */
export async function rodarConversa(
  r: ResultadoDaConversa,
  cenario: CenarioDoSimulador,
  opcoes: OpcoesDeRodada,
  sinal?: AbortSignal,
  aoMudar?: () => void,
): Promise<ResultadoDaConversa> {
  const t0 = Date.now();
  r.status = "rodando";
  const base = opcoes.agora ? new Date(opcoes.agora) : AGORA_DO_LAB;
  const s = new SessaoBella({
    modeloBella: opcoes.modeloBella,
    modeloPersona: opcoes.modeloPersona,
    divida: r.divida,
    agora: agoraDaConversa(base, cenario.hora),
    playbook: opcoes.playbook,
  });
  // O resultado aponta para as listas vivas do ambiente: o painel vê a conversa andando.
  r.conversa = s.amb.conversa;
  r.chamadas = s.amb.chamadas;
  const turnos: TurnoDaBella[] = [];
  try {
    for (let turno = 0; turno < opcoes.maxTurnos; turno++) {
      if (sinal?.aborted) throw new Error("cancelado");
      const vez = await s.vezDaBella(sinal);
      turnos.push(vez);
      r.turnos = turnos.map(({ ms, travou, vetos, erro }) => ({ ms, travou, vetos, erro }));
      aoMudar?.();
      if (vez.erro) throw new Error(vez.erro);
      if (vez.texto === null || s.amb.handoffs.length > 0) break;
      const fala = await s.falaDaPersona(cenario.persona(r.divida), cenario.cpf(r.divida), sinal);
      if (fala === null) break;
      s.devedorDiz(fala);
      aoMudar?.();
    }
    r.achados = auditar(cenario, s.amb, turnos);
    if (opcoes.modeloJuiz && s.amb.conversa.length > 0) {
      r.juiz = await julgar(s.amb, opcoes.playbook ?? playbookDaBella(), opcoes.modeloJuiz, sinal);
      for (const v of r.juiz.violacoes.filter((x) => x.gravidade === "grave")) {
        r.achados.push({ nome: `juiz: ${v.regra}`, ok: false, nivel: "falha", detalhe: `"${v.trecho}" — ${v.por_que}` });
      }
    }
    r.status = aprovada(r.achados) ? "aprovada" : "reprovada";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    r.status = sinal?.aborted ? "cancelada" : "erro";
    r.erro = msg;
  }
  r.desfechos = s.amb.estado.tabulacoes.map((t) => t.desfecho);
  r.acordo = s.amb.estado.acordos.length > 0;
  r.handoff = s.amb.handoffs.length > 0;
  r.uso = { ...s.uso };
  r.ms = Date.now() - t0;
  // Congela cópias (o ambiente sai de cena).
  r.conversa = [...s.amb.conversa];
  r.chamadas = s.amb.chamadas.map(({ nome, args, resultado, posicao }) => ({ nome, args, resultado, posicao }));
  aoMudar?.();
  return r;
}

// ---------------------------------------------------------------------------
// lote
// ---------------------------------------------------------------------------

export interface PedidoDeLote extends OpcoesDeRodada {
  nome?: string;
  cenarios: string[];
  /** Quantas vezes cada cenário escolhido roda. */
  repeticoes: number;
  /** Quantas personas aleatórias ("caos") somar. */
  caos: number;
  /** Cada conversa com uma dívida diferente (valor, atraso, credor, CPF). */
  variarDivida: boolean;
  concorrencia: number;
  semente?: number;
}

export interface Lote {
  id: string;
  nome: string;
  criadoEm: string;
  terminadoEm?: string;
  status: "rodando" | "concluido" | "cancelado";
  pedido: PedidoDeLote;
  /** Primeiras linhas do playbook usado (para reconhecer a versão). */
  playbookUsado: string;
  itens: ResultadoDaConversa[];
}

export function resumo(l: Lote) {
  const feitos = l.itens.filter((i) => !["fila", "rodando"].includes(i.status));
  const aprovadas = feitos.filter((i) => i.status === "aprovada").length;
  const falhas: Record<string, number> = {};
  const alertas: Record<string, number> = {};
  const vetos: Record<string, number> = {};
  const violacoes: Record<string, number> = {};
  const porCenario: Record<string, { titulo: string; total: number; aprovadas: number }> = {};
  let notas = 0;
  let nNotas = 0;
  let msTurno = 0;
  let nTurnos = 0;
  const uso = { entrada: 0, saida: 0, cache: 0 };
  for (const i of feitos) {
    for (const a of i.achados.filter((x) => !x.ok)) {
      const alvo = a.nivel === "falha" ? falhas : alertas;
      const nome = a.nome.startsWith("juiz: ") ? "juiz: violação grave" : a.nome;
      alvo[nome] = (alvo[nome] ?? 0) + 1;
    }
    for (const t of i.turnos) {
      for (const v of t.vetos) vetos[v.code] = (vetos[v.code] ?? 0) + 1;
      msTurno += t.ms;
      nTurnos++;
    }
    for (const v of i.juiz?.violacoes ?? []) {
      const k = `${v.gravidade}: ${v.regra}`;
      violacoes[k] = (violacoes[k] ?? 0) + 1;
    }
    if (i.juiz && !i.juiz.erro) {
      notas += i.juiz.nota;
      nNotas++;
    }
    // As personas aleatórias são todas diferentes: no resumo, viram uma linha só.
    const chave = i.cenario.grupo === "caos" ? "caos" : i.cenario.id;
    const pc = (porCenario[chave] ??= { titulo: chave === "caos" ? "Personas aleatórias" : i.cenario.titulo, total: 0, aprovadas: 0 });
    pc.total++;
    if (i.status === "aprovada") pc.aprovadas++;
    uso.entrada += i.uso.entrada;
    uso.saida += i.uso.saida;
    uso.cache += i.uso.cache;
  }
  const ordenar = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return {
    total: l.itens.length,
    feitos: feitos.length,
    rodando: l.itens.filter((i) => i.status === "rodando").length,
    aprovadas,
    reprovadas: feitos.filter((i) => i.status === "reprovada").length,
    erros: feitos.filter((i) => i.status === "erro").length,
    taxa: feitos.length ? aprovadas / feitos.length : 0,
    notaMedia: nNotas ? notas / nNotas : null,
    msPorResposta: nTurnos ? Math.round(msTurno / nTurnos) : null,
    acordos: feitos.filter((i) => i.acordo).length,
    falhas: ordenar(falhas),
    alertas: ordenar(alertas),
    vetos: ordenar(vetos),
    violacoes: ordenar(violacoes).slice(0, 15),
    porCenario: Object.entries(porCenario)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => a.aprovadas / a.total - b.aprovadas / b.total),
    uso,
  };
}

const lotes = new Map<string, Lote>();
const controles = new Map<string, AbortController>();

export function carregarLotes() {
  if (!existsSync(PASTA_LOTES)) return;
  for (const f of readdirSync(PASTA_LOTES).filter((x) => x.endsWith(".json"))) {
    try {
      const l = JSON.parse(readFileSync(path.join(PASTA_LOTES, f), "utf8")) as Lote;
      // Lote que estava rodando quando o processo caiu: o que não terminou fica cancelado.
      if (l.status === "rodando") {
        l.status = "cancelado";
        for (const i of l.itens) if (i.status === "fila" || i.status === "rodando") i.status = "cancelada";
      }
      lotes.set(l.id, l);
    } catch {
      // arquivo corrompido: ignora
    }
  }
}

export function listarLotes(): Lote[] {
  return [...lotes.values()].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

export function lote(id: string): Lote | undefined {
  return lotes.get(id);
}

const gravacoesPendentes = new Map<string, NodeJS.Timeout>();
export function gravar(l: Lote, agora = false) {
  const fazer = () => {
    gravacoesPendentes.delete(l.id);
    mkdirSync(PASTA_LOTES, { recursive: true });
    writeFileSync(path.join(PASTA_LOTES, `${l.id}.json`), JSON.stringify(l, null, 1));
  };
  if (agora) {
    clearTimeout(gravacoesPendentes.get(l.id));
    fazer();
  } else if (!gravacoesPendentes.has(l.id)) {
    gravacoesPendentes.set(l.id, setTimeout(fazer, 2000));
  }
}

export function montarItens(p: PedidoDeLote): Array<{ item: ResultadoDaConversa; cenario: CenarioDoSimulador }> {
  const base = p.agora ? new Date(p.agora) : AGORA_DO_LAB;
  const semente = p.semente ?? Math.floor(Math.random() * 100_000);
  const lista: CenarioDoSimulador[] = [];
  for (let r = 0; r < Math.max(1, p.repeticoes); r++) {
    for (const id of p.cenarios) {
      const c = cenarioPorId(id);
      if (c) lista.push(c);
    }
  }
  for (let k = 0; k < p.caos; k++) lista.push(cenarioCaos(semente + k));
  return lista.map((cenario, n) => ({
    cenario,
    item: vazio(n + 1, cenario, p.variarDivida ? dividaAleatoria(semente + n, base) : DIVIDA_PADRAO),
  }));
}

export function iniciarLote(p: PedidoDeLote): Lote {
  const fila = montarItens(p);
  if (fila.length === 0) throw new Error("escolha pelo menos um cenário ou personas aleatórias");
  const id = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
  const playbook = p.playbook ?? playbookDaBella();
  const l: Lote = {
    id,
    nome: p.nome?.trim() || `${fila.length} conversas`,
    criadoEm: new Date().toISOString(),
    status: "rodando",
    pedido: { ...p, playbook: undefined },
    playbookUsado: playbook,
    itens: fila.map((f) => f.item),
  };
  lotes.set(id, l);
  const ctl = new AbortController();
  controles.set(id, ctl);
  gravar(l, true);

  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < fila.length && !ctl.signal.aborted) {
      const f = fila[proximo++]!;
      await rodarConversa(f.item, f.cenario, { ...p, playbook }, ctl.signal, () => gravar(l));
      gravar(l);
    }
  };
  const n = Math.min(Math.max(1, p.concorrencia), 16, fila.length);
  void Promise.all(Array.from({ length: n }, trabalhador)).finally(() => {
    if (l.status === "rodando") l.status = ctl.signal.aborted ? "cancelado" : "concluido";
    for (const i of l.itens) if (i.status === "fila") i.status = "cancelada";
    l.terminadoEm = new Date().toISOString();
    controles.delete(id);
    gravar(l, true);
  });
  return l;
}

export function cancelarLote(id: string) {
  const l = lotes.get(id);
  controles.get(id)?.abort();
  if (l && l.status === "rodando") l.status = "cancelado";
}

/** Reroda UMA conversa de um lote com a mesma persona e dívida (para conferir uma correção). */
export async function reexecutar(l: Lote, n: number, opcoes: Partial<OpcoesDeRodada> = {}) {
  const antigo = l.itens.find((i) => i.n === n);
  if (!antigo) throw new Error("conversa não encontrada");
  const cenario = cenarioPorId(antigo.cenario.id);
  if (!cenario) throw new Error("cenário não existe mais");
  const r = vazio(n, cenario, antigo.divida);
  return rodarConversa(r, cenario, { ...l.pedido, playbook: l.playbookUsado, ...opcoes });
}
