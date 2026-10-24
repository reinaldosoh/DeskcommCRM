-- manifest: **Bella: desconto gradual, cuidado e retorno com memória.** Em `recuperacao_dividas`: `desconto_liberado_pct` e `desconto_liberado_job` (o desconto à vista sobe um degrau por vez, de `passoDescontoPct` em `passoDescontoPct`, e só um degrau por run — a agente nunca enxerga o teto da faixa), `devedor_cidade`/`devedor_uf` (do cadastro do credor: os contatos de ajuda numa crise são os da região), `contexto_do_retorno` (o que a pessoa contou e importa quando a agente retoma o contato combinado) e `cuidado_em` (sinal de risco à vida: a cobrança para e só um humano libera). Tudo `add column if not exists`, reaplicável pelo apêndice do baseline.
-- 0651: desconto gradual, cuidado e retorno com memória da Bella.

alter table public.recuperacao_dividas
  add column if not exists desconto_liberado_pct numeric(5, 2)
    check (desconto_liberado_pct is null or (desconto_liberado_pct >= 0 and desconto_liberado_pct <= 100)),
  add column if not exists desconto_liberado_job text,
  add column if not exists devedor_cidade text check (devedor_cidade is null or length(devedor_cidade) between 1 and 80),
  add column if not exists devedor_uf text check (devedor_uf is null or devedor_uf ~ '^[A-Z]{2}$'),
  add column if not exists contexto_do_retorno text check (contexto_do_retorno is null or length(contexto_do_retorno) <= 600),
  add column if not exists cuidado_em timestamptz;

comment on column public.recuperacao_dividas.desconto_liberado_pct is
  'Desconto à vista já liberado na negociação (null = o inicial da faixa). Sobe um passo por vez, nunca direto ao teto.';
comment on column public.recuperacao_dividas.cuidado_em is
  'Sinal de risco à vida na conversa: nenhuma cobrança nem retorno automático até um humano limpar este campo.';
