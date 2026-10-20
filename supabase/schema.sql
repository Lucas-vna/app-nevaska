-- =============================================================================
-- Nevaska — estrutura do banco no Supabase
--
-- Como usar: no painel do Supabase, abra "SQL Editor" → "New query",
-- cole TODO este arquivo e clique em "Run". Pode rodar de novo sem problema.
-- =============================================================================

-- Estado atual de cada freezer (uma linha por freezer).
-- Os horários são em milissegundos (Date.now() do JavaScript).
create table if not exists public.freezers (
  id                    text primary key,          -- "NEVASKA_SC/freezer_01"
  loja                  text not null,
  freezer               text not null,
  temp                  double precision,          -- última temperatura válida (°C)
  last_seen             bigint,                    -- quando chegou a última leitura
  acima_desde           bigint not null default 0, -- desde quando está acima do limite
  temp_alerta           boolean not null default false,
  ultimo_aviso_temp     bigint not null default 0,
  offline_alerta        boolean not null default false,
  offline_desde         bigint not null default 0,
  ultimo_aviso_offline  bigint not null default 0,
  sensor_falha          boolean not null default false,
  atualizado_em         timestamptz not null default now()
);

-- Celulares inscritos para receber Web Push.
create table if not exists public.inscricoes_push (
  endpoint   text primary key,
  dados      jsonb not null,
  criado_em  timestamptz not null default now()
);

-- Trava simples para o watchdog não rodar duas vezes ao mesmo tempo.
create table if not exists public.travas (
  nome  text primary key,
  ate   bigint not null
);

-- Pega a trava se ela estiver livre (ou vencida). Devolve true se conseguiu.
create or replace function public.pegar_trava(p_nome text, p_ttl_ms bigint)
returns boolean
language plpgsql
as $$
declare
  agora bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  insert into public.travas (nome, ate)
  values (p_nome, agora + p_ttl_ms)
  on conflict (nome) do update
    set ate = excluded.ate
    where public.travas.ate < agora;
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- Segurança: liga o RLS sem nenhuma política. Resultado: as chaves públicas do
-- Supabase (anon/publishable) NÃO conseguem ler nem gravar nada. Só o servidor
-- na Vercel, usando a chave secreta (service_role/secret), tem acesso.
-- -----------------------------------------------------------------------------
alter table public.freezers        enable row level security;
alter table public.inscricoes_push enable row level security;
alter table public.travas          enable row level security;

revoke execute on function public.pegar_trava(text, bigint) from public, anon, authenticated;
grant  execute on function public.pegar_trava(text, bigint) to service_role;
