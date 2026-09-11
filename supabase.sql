-- Loan Ledger: encrypted vault storage
-- Run this entire script in Supabase SQL Editor.
--
-- Design:
--  * The browser encrypts the complete loan JSON with PBKDF2 + AES-GCM.
--  * Supabase stores only ciphertext + salt + IV.
--  * A high-entropy vault_code acts as the lookup/link code.
--  * The PIN is NEVER sent to Supabase.

create table if not exists public.encrypted_vaults (
  vault_code text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.encrypted_vaults enable row level security;

-- Do not expose the table directly through the Data API.
revoke all on table public.encrypted_vaults from anon;
revoke all on table public.encrypted_vaults from authenticated;

-- Remove old functions if re-running the script.
drop function if exists public.get_encrypted_vault(text);
drop function if exists public.save_encrypted_vault(text, jsonb);

-- Read one vault by its high-entropy vault code.
-- SECURITY DEFINER is intentional: the table itself is not directly exposed.
create or replace function public.get_encrypted_vault(p_vault_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'payload', payload,
    'updated_at', updated_at
  )
  into result
  from public.encrypted_vaults
  where vault_code = p_vault_code;

  return result;
end;
$$;

-- Create/update one vault.
create or replace function public.save_encrypted_vault(
  p_vault_code text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if length(p_vault_code) < 32 then
    raise exception 'Invalid vault code';
  end if;

  insert into public.encrypted_vaults(vault_code, payload, updated_at)
  values (p_vault_code, p_payload, now())
  on conflict (vault_code)
  do update set payload = excluded.payload, updated_at = now();

  select jsonb_build_object(
    'ok', true,
    'updated_at', updated_at
  )
  into result
  from public.encrypted_vaults
  where vault_code = p_vault_code;

  return result;
end;
$$;

grant execute on function public.get_encrypted_vault(text) to anon, authenticated;
grant execute on function public.save_encrypted_vault(text, jsonb) to anon, authenticated;

-- Optional: revoke public execution if your project has broad default grants.
revoke all on function public.get_encrypted_vault(text) from public;
revoke all on function public.save_encrypted_vault(text, jsonb) from public;
grant execute on function public.get_encrypted_vault(text) to anon, authenticated;
grant execute on function public.save_encrypted_vault(text, jsonb) to anon, authenticated;
