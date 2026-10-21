/**
 * Prepara a validação LOCAL da Bella: uma carteira de teste (Banco Nova Era),
 * o devedor João com a dívida do teste real da Mia (R$ 3.769,76, vencida desde
 * 10/03/2026) e a Bella como RASCUNHO de agente.
 *
 *   pnpm bella:semear --telefone +5522999999999 [--cpf3 123] [--org <uuid>]
 *
 * `--telefone` é o número de WhatsApp que vai fazer o papel do devedor (o seu,
 * para conversar com ela). `--cpf3` são os 3 primeiros dígitos que a Bella vai
 * pedir — invente, não precisa ser um CPF real.
 *
 * Só escreve em banco LOCAL (localhost/127.x): recusa qualquer outro destino.
 * Idempotente: rodar de novo atualiza a dívida e não duplica nada.
 */
import pg from "pg";

import { createMcpAgentDraft } from "@/lib/ai/agents/create-draft";
import { NOME_DA_AGENTE, rascunhoDaBella } from "@/lib/recuperacao/bella/definicao";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "./lib/env-de-teste";

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const telefone = arg("telefone");
  const cpf3 = arg("cpf3") ?? "123";
  if (!telefone || !/^\+\d{8,15}$/.test(telefone)) {
    throw new Error("informe --telefone no formato +5522999999999 (o WhatsApp que fará o papel do devedor)");
  }
  if (!/^\d{3}$/.test(cpf3)) throw new Error("--cpf3 precisa ser 3 dígitos");

  const { dbUrl } = credenciaisSupabaseDeTeste();
  if (!dbUrl) throw new Error("SUPABASE_DB_URL ausente no .env.local — rode `pnpm local:up` antes");
  if (!destinoEhLocal(dbUrl)) throw new Error("recusado: o banco do .env.local não é local; este script só semeia ambiente local");

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("begin");

    const orgs = await client.query<{ id: string; name: string }>(
      arg("org") ? "select id, display_name as name from organizations where id = $1" : "select id, display_name as name from organizations order by created_at",
      arg("org") ? [arg("org")] : [],
    );
    if (orgs.rows.length !== 1) {
      throw new Error(
        orgs.rows.length === 0
          ? "nenhuma organização — crie o usuário dono antes (scripts/bootstrap-owner.ts)"
          : `há ${orgs.rows.length} organizações; escolha uma com --org: ${orgs.rows.map((o) => `${o.id} (${o.name})`).join(", ")}`,
      );
    }
    const org = orgs.rows[0]!;
    const dono = await client.query<{ user_id: string }>(
      `select user_id from user_organizations
        where organization_id = $1 and revoked_at is null
        order by case role when 'admin' then 0 when 'manager' then 1 else 2 end, created_at limit 1`,
      [org.id],
    );
    const userId = dono.rows[0]?.user_id;
    if (!userId) throw new Error("a organização não tem membro ativo");

    const contato = await client.query<{ id: string }>(
      `insert into contacts (organization_id, name, phone_number, source)
       values ($1, 'João Carlos (teste Bella)', $2, 'manual')
       on conflict (organization_id, phone_number) where phone_number is not null and is_merged_into is null
       do update set updated_at = now()
       returning id`,
      [org.id, telefone],
    );
    const contatoId = contato.rows[0]!.id;

    let carteira = await client.query<{ id: string }>(
      "select id from recuperacao_carteiras where organization_id = $1 and nome = 'Carteira de teste'",
      [org.id],
    );
    if (carteira.rows.length === 0) {
      carteira = await client.query<{ id: string }>(
        `insert into recuperacao_carteiras (organization_id, nome, credor_nome)
         values ($1, 'Carteira de teste', 'Banco Nova Era') returning id`,
        [org.id],
      );
    }
    const carteiraId = carteira.rows[0]!.id;

    // Recomeça a dívida do zero a cada execução: identidade, acordo e opt-out
    // de um teste anterior não contaminam o próximo.
    const divida = await client.query<{ id: string }>(
      `insert into recuperacao_dividas
         (organization_id, carteira_id, contact_id, referencia_externa, produto, valor_devido_cents,
          vencimento_original, parcelas_vencidas, cpf_prefixo)
       values ($1, $2, $3, 'LAB-JOAO-001', 'cartão de crédito', 376976, '2026-03-10', 7, $4)
       on conflict (carteira_id, referencia_externa) where referencia_externa is not null
       do update set contact_id = excluded.contact_id, cpf_prefixo = excluded.cpf_prefixo, status = 'aberta',
                     identidade_tentativas = 0, identidade_verificada_em = null, identidade_bloqueada_ate = null,
                     opt_out_em = null, retornar_em = null, ultimo_desfecho = null, updated_at = now()
       returning id`,
      [org.id, carteiraId, contatoId, cpf3],
    );
    const dividaId = divida.rows[0]!.id;
    await client.query(
      "update recuperacao_acordos set status = 'cancelado', updated_at = now() where organization_id = $1 and divida_id = $2 and status = 'ativo'",
      [org.id, dividaId],
    );

    const agente = await client.query<{ id: string }>(
      "select id from ai_agents where organization_id = $1 and name = $2 limit 1",
      [org.id, NOME_DA_AGENTE],
    );
    let agenteId = agente.rows[0]?.id;
    if (!agenteId) {
      const criado = await createMcpAgentDraft(client as unknown as pg.PoolClient, { orgId: org.id, userId }, rascunhoDaBella());
      agenteId = criado.agent.id as string;
    }

    await client.query("commit");
    console.info(`✓ Organização: ${org.name}`);
    console.info(`✓ Devedor: João Carlos (${telefone}) · dívida R$ 3.769,76 no cartão do Banco Nova Era`);
    console.info(`✓ 3 primeiros dígitos do CPF que a Bella vai pedir: ${cpf3}`);
    console.info(`✓ Bella criada como rascunho (agente ${agenteId}). Publique e ligue ao número em Agentes.`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
