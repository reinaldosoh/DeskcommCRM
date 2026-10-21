import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * COBRANÇA — o painel da recuperação de crédito (Pacare / Bella).
 *
 * Só leitura, pela sessão do usuário: a RLS de `recuperacao_*` (migration
 * 0650) já recorta a organização, e a escrita continua sendo da Bella (pelas
 * ferramentas `cobranca_*`) ou do seed. O que a tela responde é o que o gestor
 * da carteira pergunta de manhã: quanto está em aberto, quanto virou acordo e
 * como terminou cada conversa.
 */

type Divida = {
  id: string;
  contact_id: string | null;
  produto: string;
  valor_devido_cents: number;
  vencimento_original: string;
  status: string;
  ultimo_desfecho: string | null;
  retornar_em: string | null;
  opt_out_em: string | null;
  carteira_id: string;
};
type Acordo = {
  id: string;
  contact_id: string | null;
  forma: string;
  total_cents: number;
  desconto_pct: number;
  parcelas: number;
  entrada_cents: number;
  parcela_cents: number;
  meio_pagamento: string;
  status: string;
  created_at: string;
};
type Tabulacao = {
  id: string;
  contact_id: string | null;
  desfecho: string;
  motivo: string | null;
  canal: string;
  created_at: string;
};
type Carteira = { id: string; nome: string; credor_nome: string };
type Contato = { id: string; name: string | null; display_name: string | null; phone: string | null };

const DESFECHO: Record<string, { rotulo: string; tom: "success" | "warning" | "error" | "info" | "neutral" }> = {
  identidade_confirmada: { rotulo: "Identidade confirmada", tom: "info" },
  acordo_realizado: { rotulo: "Acordo realizado", tom: "success" },
  acordo_nao_realizado: { rotulo: "Acordo não realizado", tom: "error" },
  contra_proposta: { rotulo: "Contraproposta", tom: "warning" },
  retornar_contato: { rotulo: "Retornar contato", tom: "warning" },
  recusa_de_informacao: { rotulo: "Recusou informar", tom: "error" },
  cobranca_indisponivel: { rotulo: "Cobrança indisponível", tom: "neutral" },
  numero_errado: { rotulo: "Número errado", tom: "neutral" },
  opt_out: { rotulo: "Pediu para parar", tom: "error" },
};

const STATUS_DIVIDA: Record<string, { rotulo: string; tom: "success" | "warning" | "error" | "info" | "neutral" }> = {
  aberta: { rotulo: "Em aberto", tom: "warning" },
  em_acordo: { rotulo: "Em acordo", tom: "info" },
  quitada: { rotulo: "Quitada", tom: "success" },
  cancelada: { rotulo: "Cancelada", tom: "neutral" },
};

const STATUS_ACORDO: Record<string, { rotulo: string; tom: "success" | "warning" | "error" | "info" | "neutral" }> = {
  ativo: { rotulo: "Ativo", tom: "info" },
  quitado: { rotulo: "Quitado", tom: "success" },
  quebrado: { rotulo: "Quebrado", tom: "error" },
  cancelado: { rotulo: "Cancelado", tom: "neutral" },
};

function reais(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
}

function data(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function dataHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function diasDeAtraso(vencimento: string): number {
  const ms = Date.now() - new Date(`${vencimento}T12:00:00-03:00`).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const supabase = await createClient();
  const [carteirasR, dividasR, acordosR, tabulacoesR] = await Promise.all([
    supabase.from("recuperacao_carteiras").select("id, nome, credor_nome").eq("organization_id", org.orgId),
    supabase
      .from("recuperacao_dividas")
      .select(
        "id, contact_id, produto, valor_devido_cents, vencimento_original, status, ultimo_desfecho, retornar_em, opt_out_em, carteira_id",
      )
      .eq("organization_id", org.orgId)
      .order("valor_devido_cents", { ascending: false })
      .limit(200),
    supabase
      .from("recuperacao_acordos")
      .select(
        "id, contact_id, forma, total_cents, desconto_pct, parcelas, entrada_cents, parcela_cents, meio_pagamento, status, created_at",
      )
      .eq("organization_id", org.orgId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("recuperacao_tabulacoes")
      .select("id, contact_id, desfecho, motivo, canal, created_at")
      .eq("organization_id", org.orgId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const carteiras = (carteirasR.data ?? []) as Carteira[];
  const dividas = (dividasR.data ?? []) as Divida[];
  const acordos = (acordosR.data ?? []) as Acordo[];
  const tabulacoes = (tabulacoesR.data ?? []) as Tabulacao[];
  const falhou = [carteirasR, dividasR, acordosR, tabulacoesR].some((r) => r.error);

  const idsDeContato = [
    ...new Set([...dividas, ...acordos, ...tabulacoes].map((l) => l.contact_id).filter((id): id is string => !!id)),
  ];
  const contatos = new Map<string, Contato>();
  if (idsDeContato.length > 0) {
    const { data: linhas } = await supabase
      .from("contacts")
      .select("id, name, display_name, phone")
      .eq("organization_id", org.orgId)
      .in("id", idsDeContato);
    for (const c of (linhas ?? []) as Contato[]) contatos.set(c.id, c);
  }
  const quem = (id: string | null) => {
    const c = id ? contatos.get(id) : undefined;
    return nomeDoContato(c) ?? c?.phone ?? "Devedor";
  };
  const credorDe = new Map(carteiras.map((c) => [c.id, c.credor_nome]));

  const emAberto = dividas.filter((d) => d.status === "aberta");
  const totalEmAberto = emAberto.reduce((s, d) => s + d.valor_devido_cents, 0);
  const acordosValidos = acordos.filter((a) => a.status !== "cancelado");
  const totalAcordado = acordosValidos.reduce((s, a) => s + a.total_cents, 0);
  const conversas = tabulacoes.length;
  const taxaDeAcordo =
    conversas > 0
      ? Math.round((tabulacoes.filter((t) => t.desfecho === "acordo_realizado").length / conversas) * 100)
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Cobrança</h1>
        <p className="text-sm text-text-muted">
          A carteira que a Bella negocia: o que está em aberto, o que virou acordo e como terminou cada conversa.
        </p>
      </div>

      {falhou && (
        <p className="rounded-md border border-border bg-warning-bg p-3 text-sm text-warning-fg">
          Parte dos dados de cobrança não pôde ser lida agora. Recarregue a página em instantes.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi titulo="Em aberto" valor={reais(totalEmAberto)} detalhe={`${emAberto.length} dívida(s)`} />
        <Kpi titulo="Acordado" valor={reais(totalAcordado)} detalhe={`${acordosValidos.length} acordo(s)`} />
        <Kpi titulo="Conversas" valor={String(conversas)} detalhe="com resultado registrado" />
        <Kpi
          titulo="Taxa de acordo"
          valor={taxaDeAcordo === null ? "—" : `${taxaDeAcordo}%`}
          detalhe="das conversas com resultado"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Devedores</CardTitle>
          <CardDescription>
            {carteiras.length === 0
              ? "Nenhuma carteira cadastrada ainda."
              : `Carteiras: ${carteiras.map((c) => `${c.nome} (${c.credor_nome})`).join(", ")}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {dividas.length === 0 ? (
            <Vazio texto="Nenhuma dívida na carteira. Importe devedores ou rode a semente de teste." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Devedor</TableHead>
                  <TableHead>Credor / produto</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead className="text-right">Atraso</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Último resultado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dividas.map((d) => {
                  const st = STATUS_DIVIDA[d.status] ?? { rotulo: d.status, tom: "neutral" as const };
                  const ult = d.ultimo_desfecho ? DESFECHO[d.ultimo_desfecho] : undefined;
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">
                        {quem(d.contact_id)}
                        {d.opt_out_em && <span className="ml-2 text-xs text-error-fg">não contatar</span>}
                      </TableCell>
                      <TableCell>
                        {credorDe.get(d.carteira_id) ?? "—"}
                        <span className="block text-xs text-text-muted">{d.produto}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{reais(d.valor_devido_cents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{diasDeAtraso(d.vencimento_original)} dias</TableCell>
                      <TableCell>
                        <Badge variant={st.tom}>{st.rotulo}</Badge>
                      </TableCell>
                      <TableCell>
                        {ult ? <Badge variant={ult.tom}>{ult.rotulo}</Badge> : <span className="text-text-muted">—</span>}
                        {d.retornar_em && (
                          <span className="block text-xs text-text-muted">retornar em {dataHora(d.retornar_em)}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Acordos</CardTitle>
            <CardDescription>Fechados pela Bella ou pela equipe, com o PIX ou boleto enviado.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {acordos.length === 0 ? (
              <Vazio texto="Nenhum acordo fechado ainda." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Devedor</TableHead>
                    <TableHead>Condição</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Quando</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acordos.map((a) => {
                    const st = STATUS_ACORDO[a.status] ?? { rotulo: a.status, tom: "neutral" as const };
                    const condicao =
                      a.forma === "a_vista"
                        ? `À vista no ${a.meio_pagamento === "pix" ? "PIX" : "boleto"}`
                        : `Entrada ${reais(a.entrada_cents)} + ${a.parcelas - 1}x ${reais(a.parcela_cents)}`;
                    return (
                      <TableRow key={a.id}>
                        <TableCell className="font-medium">{quem(a.contact_id)}</TableCell>
                        <TableCell>
                          {condicao}
                          {Number(a.desconto_pct) > 0 && (
                            <span className="block text-xs text-text-muted">{Number(a.desconto_pct)}% de desconto</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{reais(a.total_cents)}</TableCell>
                        <TableCell>
                          <Badge variant={st.tom}>{st.rotulo}</Badge>
                        </TableCell>
                        <TableCell>{data(a.created_at)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resultado das conversas</CardTitle>
            <CardDescription>A tabulação que a Bella registra ao fim de cada negociação.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {tabulacoes.length === 0 ? (
              <Vazio texto="Nenhuma conversa terminada ainda." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Devedor</TableHead>
                    <TableHead>Resultado</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Quando</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tabulacoes.map((t) => {
                    const d = DESFECHO[t.desfecho] ?? { rotulo: t.desfecho, tom: "neutral" as const };
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{quem(t.contact_id)}</TableCell>
                        <TableCell>
                          <Badge variant={d.tom}>{d.rotulo}</Badge>
                        </TableCell>
                        <TableCell className="text-text-muted">{t.motivo ?? "—"}</TableCell>
                        <TableCell>{dataHora(t.created_at)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ titulo, valor, detalhe }: { titulo: string; valor: string; detalhe: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-text-muted">{titulo}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{valor}</p>
        <p className="text-xs text-text-muted">{detalhe}</p>
      </CardContent>
    </Card>
  );
}

function Vazio({ texto }: { texto: string }) {
  return <p className="py-6 text-center text-sm text-text-muted">{texto}</p>;
}
