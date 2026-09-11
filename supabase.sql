-- Loan Ledger encrypted vault
-- Run this whole script in Supabase SQL Editor.

create table if not exists public.encrypted_vaults (
  vault_code text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.encrypted_vaults enable row level security;
revoke all on table public.encrypted_vaults from anon, authenticated;

drop function if exists public.get_encrypted_vault(text);
drop function if exists public.save_encrypted_vault(text, jsonb);

-- These functions intentionally expose only a high-entropy vault-code lookup.
-- The actual loan data is encrypted client-side before being stored.
-- search_path is pinned as recommended for SECURITY DEFINER functions.
create or replace function public.get_encrypted_vault(p_vault_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  select jsonb_build_object('payload', v.payload, 'updated_at', v.updated_at)
  into result
  from public.encrypted_vaults v
  where v.vault_code = p_vault_code;
  return result;
end;
$$;

create or replace function public.save_encrypted_vault(p_vault_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  if length(p_vault_code) < 32 then
    raise exception 'Invalid vault code';
  end if;

  insert into public.encrypted_vaults(vault_code, payload, updated_at)
  values (p_vault_code, p_payload, now())
  on conflict (vault_code)
  do update set payload = excluded.payload, updated_at = now();

  select jsonb_build_object('ok', true, 'updated_at', v.updated_at)
  into result
  from public.encrypted_vaults v
  where v.vault_code = p_vault_code;
  return result;
end;
$$;

revoke execute on function public.get_encrypted_vault(text) from public;
revoke execute on function public.save_encrypted_vault(text, jsonb) from public;
grant execute on function public.get_encrypted_vault(text) to anon, authenticated;
grant execute on function public.save_encrypted_vault(text, jsonb) to anon, authenticated;
