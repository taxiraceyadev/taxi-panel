-- ============================================================
-- Panel de notificaciones SMS (TaxiCaller -> RingCentral)
-- Esquema de base de datos para Supabase
-- Ejecutar completo en: Supabase Dashboard -> SQL Editor
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Unidades actualmente "en espera"
--    Evita que la misma unidad genere una fila nueva (y un SMS
--    nuevo) cada vez que TaxiCaller reenvía el mismo estado.
-- ------------------------------------------------------------
create table if not exists public.vehicles_on_hold (
  id                   uuid primary key default gen_random_uuid(),
  taxicaller_vehicle_id text unique,          -- id de vehículo que manda TaxiCaller (ajustar mapeo en la Edge Function)
  vehicle_label        text not null,          -- nombre / número de unidad
  plate                text not null,
  status                text not null default 'on_hold' check (status in ('on_hold','cleared')),
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

create index if not exists idx_vehicles_on_hold_status on public.vehicles_on_hold(status);

-- ------------------------------------------------------------
-- 2. Historial de SMS enviados (lo que alimenta el panel)
-- ------------------------------------------------------------
create table if not exists public.messages_log (
  id                  uuid primary key default gen_random_uuid(),
  vehicle_label       text,
  plate                text,
  phone                text not null,
  message_body         text,
  status                text not null check (status in ('sent','failed')),
  error_detail          text,
  taxicaller_event_id   text,
  sent_at               timestamptz not null default now()
);

create index if not exists idx_messages_log_sent_at on public.messages_log(sent_at desc);

-- ------------------------------------------------------------
-- 3. Configuración (una sola fila). Los valores sensibles NUNCA
--    se exponen directo al panel: se leen/escriben solo a través
--    de las funciones de abajo.
-- ------------------------------------------------------------
create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),
  server_url       text,
  client_id        text,
  client_secret     text,
  jwt_credential    text,
  extension_id      text,
  from_number       text,
  updated_at        timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.vehicles_on_hold enable row level security;
alter table public.messages_log enable row level security;
alter table public.settings enable row level security;

-- El panel (usuario logueado con Supabase Auth) puede LEER
-- unidades y mensajes. La Edge Function usa la service_role key
-- y no depende de estas políticas (las ignora).
create policy "panel lee unidades" on public.vehicles_on_hold
  for select using (auth.role() = 'authenticated');

create policy "panel lee mensajes" on public.messages_log
  for select using (auth.role() = 'authenticated');

-- Para 'settings' NO se crea ninguna policy de select/insert/update:
-- eso significa que ni 'authenticated' ni 'anon' pueden tocar la tabla
-- directamente. Solo se accede a través de las funciones de abajo.

-- ============================================================
-- Lectura enmascarada de settings (para mostrar en la tuerquita)
-- ============================================================
create or replace function public.admin_get_settings_status()
returns table (
  server_url          text,
  extension_id         text,
  from_number           text,
  client_id_hint         text,
  client_id_set           boolean,
  client_secret_set        boolean,
  jwt_credential_set        boolean,
  updated_at                 timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    s.server_url,
    s.extension_id,
    s.from_number,
    case when s.client_id is not null and length(s.client_id) > 4
         then '••••' || right(s.client_id, 4)
         else null end,
    s.client_id is not null,
    s.client_secret is not null,
    s.jwt_credential is not null,
    s.updated_at
  from public.settings s
  where s.id = 1;
$$;

revoke all on function public.admin_get_settings_status() from public;
grant execute on function public.admin_get_settings_status() to authenticated;

-- ============================================================
-- Escritura de settings. Cualquier parámetro en null/'' se deja
-- como estaba -> así el panel puede actualizar un solo campo por
-- vez sin pisar el resto con vacíos.
-- ============================================================
create or replace function public.admin_update_settings(
  p_server_url       text default null,
  p_client_id         text default null,
  p_client_secret      text default null,
  p_jwt_credential      text default null,
  p_extension_id         text default null,
  p_from_number            text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.settings set
    server_url      = coalesce(nullif(p_server_url, ''), server_url),
    client_id       = coalesce(nullif(p_client_id, ''), client_id),
    client_secret   = coalesce(nullif(p_client_secret, ''), client_secret),
    jwt_credential  = coalesce(nullif(p_jwt_credential, ''), jwt_credential),
    extension_id    = coalesce(nullif(p_extension_id, ''), extension_id),
    from_number     = coalesce(nullif(p_from_number, ''), from_number),
    updated_at      = now()
  where id = 1;
end;
$$;

revoke all on function public.admin_update_settings from public;
grant execute on function public.admin_update_settings to authenticated;

-- ============================================================
-- Realtime: para que el panel vea los mensajes apenas se insertan
-- ============================================================
alter publication supabase_realtime add table public.messages_log;
alter publication supabase_realtime add table public.vehicles_on_hold;
