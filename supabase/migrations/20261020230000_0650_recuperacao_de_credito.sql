-- manifest: **Recuperação de crédito (Pacare / agente Bella).** Núcleo do produto de cobrança: `recuperacao_carteiras` (o credor e a política que ele autoriza: faixas de desconto, parcelas, entrada mínima, janela de contato), `recuperacao_dividas` (a dívida de um contato, com o PREFIXO do CPF — só os 3 dígitos que a confirmação de identidade usa, minimização LGPD — e o estado da identidade, opt-out e retorno agendado), `recuperacao_acordos` (o acordo fechado, imutável depois de quitado), `recuperacao_cobrancas` (PIX/boleto de cada parcela, com `provedor` trocável: `fake` na validação, Pixxifeito depois) e `recuperacao_tabulacoes` (o desfecho de cada conversa, as 7 tabulações da Mia + `numero_errado` e `opt_out`, que alimentam o painel). RLS por operação: leitura para a organização, escrita `manager`+; o agente escreve pelo service role, sempre filtrando `organization_id`. Tudo idempotente (`if not exists` / `drop policy if exists`), reaplicável pelo apêndice do baseline.
-- 0650: recuperação de crédito.

create table if not exists public.recuperacao_carteiras (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null check (length(nome) between 1 and 120),
  -- O nome que aparece para o devedor ("Banco Nova Era").
  credor_nome text not null check (length(credor_nome) between 1 and 120),
  -- PoliticaDeNegociacao (lib/recuperacao/tipos.ts). Validada pelo app; o
  -- banco só garante que é um objeto.
  politica jsonb not null default '{}'::jsonb check (jsonb_typeof(politica) = 'object'),
  -- Janela de contato (horário local da organização). CDC/Procon: nada de
  -- cobrança de madrugada nem em horário de descanso.
  contato_hora_inicio smallint not null default 8 check (contato_hora_inicio between 0 and 23),
  contato_hora_fim smallint not null default 20 check (contato_hora_fim between 1 and 24),
  contato_dias smallint[] not null default '{1,2,3,4,5,6}' check (contato_dias <@ '{0,1,2,3,4,5,6}'::smallint[]),
  ativa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recuperacao_carteiras_janela_valida check (contato_hora_inicio < contato_hora_fim)
);
create index if not exists recuperacao_carteiras_org_idx on public.recuperacao_carteiras (organization_id);

create table if not exists public.recuperacao_dividas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  carteira_id uuid not null references public.recuperacao_carteiras(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  -- Código da dívida no sistema do credor (para conciliar na volta).
  referencia_externa text,
  produto text not null check (length(produto) between 1 and 120),
  valor_devido_cents bigint not null check (valor_devido_cents > 0),
  vencimento_original date not null,
  parcelas_vencidas integer check (parcelas_vencidas is null or parcelas_vencidas >= 0),
  -- Só o prefixo: é tudo que a confirmação de identidade precisa.
  cpf_prefixo text check (cpf_prefixo is null or cpf_prefixo ~ '^[0-9]{3}$'),
  status text not null default 'aberta' check (status in ('aberta', 'em_acordo', 'quitada', 'cancelada')),
  identidade_tentativas smallint not null default 0 check (identidade_tentativas >= 0),
  identidade_verificada_em timestamptz,
  identidade_bloqueada_ate timestamptz,
  -- Pediu para não receber mais: nenhuma mensagem ativa depois disto.
  opt_out_em timestamptz,
  -- "Me chama semana que vem": a régua respeita.
  retornar_em timestamptz,
  ultimo_desfecho text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recuperacao_dividas_org_idx on public.recuperacao_dividas (organization_id);
create index if not exists recuperacao_dividas_contato_idx
  on public.recuperacao_dividas (organization_id, contact_id) where contact_id is not null;
create index if not exists recuperacao_dividas_retorno_idx
  on public.recuperacao_dividas (organization_id, retornar_em) where retornar_em is not null and opt_out_em is null;
create unique index if not exists recuperacao_dividas_referencia_unica
  on public.recuperacao_dividas (carteira_id, referencia_externa) where referencia_externa is not null;

create table if not exists public.recuperacao_acordos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  divida_id uuid not null references public.recuperacao_dividas(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  forma text not null check (forma in ('a_vista', 'parcelado')),
  total_cents bigint not null check (total_cents > 0),
  desconto_pct numeric(5,2) not null default 0 check (desconto_pct >= 0 and desconto_pct <= 100),
  desconto_cents bigint not null default 0 check (desconto_cents >= 0),
  parcelas integer not null check (parcelas >= 1),
  entrada_cents bigint not null check (entrada_cents > 0),
  parcela_cents bigint not null default 0 check (parcela_cents >= 0),
  primeiro_vencimento date not null,
  meio_pagamento text not null default 'pix' check (meio_pagamento in ('pix', 'boleto')),
  status text not null default 'ativo' check (status in ('ativo', 'quitado', 'quebrado', 'cancelado')),
  -- Quem fechou: o job do agente (rastreabilidade do turno) ou um humano.
  source_job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recuperacao_acordos_fecha_a_conta check (
    (forma = 'a_vista' and parcelas = 1 and entrada_cents = total_cents and parcela_cents = 0)
    or (forma = 'parcelado' and parcelas >= 2 and entrada_cents + parcela_cents * (parcelas - 1) = total_cents)
  )
);
create index if not exists recuperacao_acordos_org_idx on public.recuperacao_acordos (organization_id);
create index if not exists recuperacao_acordos_divida_idx on public.recuperacao_acordos (organization_id, divida_id);
-- Um acordo ATIVO por dívida: o segundo "fechar" do mesmo turno não duplica.
create unique index if not exists recuperacao_acordos_um_ativo_por_divida
  on public.recuperacao_acordos (divida_id) where status = 'ativo';

create table if not exists public.recuperacao_cobrancas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  acordo_id uuid not null references public.recuperacao_acordos(id) on delete cascade,
  parcela integer not null check (parcela >= 1),
  valor_cents bigint not null check (valor_cents > 0),
  vencimento date not null,
  meio text not null check (meio in ('pix', 'boleto')),
  provedor text not null,
  id_externo text not null,
  teste boolean not null default false,
  pix_copia_e_cola text,
  boleto_linha_digitavel text,
  status text not null default 'pendente' check (status in ('pendente', 'paga', 'vencida', 'cancelada')),
  paga_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recuperacao_cobrancas_parcela_unica unique (acordo_id, parcela, meio)
);
create index if not exists recuperacao_cobrancas_org_idx on public.recuperacao_cobrancas (organization_id);
create index if not exists recuperacao_cobrancas_pendentes_idx
  on public.recuperacao_cobrancas (organization_id, vencimento) where status = 'pendente';

create table if not exists public.recuperacao_tabulacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  divida_id uuid references public.recuperacao_dividas(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  desfecho text not null check (desfecho in (
    'identidade_confirmada', 'acordo_realizado', 'acordo_nao_realizado', 'contra_proposta',
    'retornar_contato', 'recusa_de_informacao', 'cobranca_indisponivel', 'numero_errado', 'opt_out'
  )),
  -- Motivo curto, sem dado pessoal (ex.: "desempregado", "valor alto").
  motivo text check (motivo is null or length(motivo) <= 200),
  canal text not null default 'whatsapp' check (canal in ('whatsapp', 'voz', 'outro')),
  source_job_id text,
  created_at timestamptz not null default now()
);
create index if not exists recuperacao_tabulacoes_org_tempo_idx
  on public.recuperacao_tabulacoes (organization_id, created_at desc);
create index if not exists recuperacao_tabulacoes_divida_idx
  on public.recuperacao_tabulacoes (organization_id, divida_id);

-- ── RLS por operação: leitura para a organização, escrita manager+ ─────────
do $rls$
declare
  t text;
begin
  foreach t in array array[
    'recuperacao_carteiras', 'recuperacao_dividas', 'recuperacao_acordos',
    'recuperacao_cobrancas', 'recuperacao_tabulacoes'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using ('
      'organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())',
      t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert with check ('
      'public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) '
      'and public.fn_role_at_least(organization_id, ''manager'')))',
      t || '_insert', t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update using ('
      'public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) '
      'and public.fn_role_at_least(organization_id, ''manager''))) with check ('
      'public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) '
      'and public.fn_role_at_least(organization_id, ''manager'')))',
      t || '_update', t);

    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete using ('
      'public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) '
      'and public.fn_role_at_least(organization_id, ''manager'')))',
      t || '_delete', t);

    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$rls$;

comment on table public.recuperacao_dividas is
  'Dívida de um contato numa carteira. Guarda só o prefixo do CPF (3 dígitos) para a confirmação de identidade.';
comment on table public.recuperacao_tabulacoes is
  'Desfecho de cada conversa de cobrança. Fonte do painel de resultados.';
