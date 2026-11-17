-- The 15 minute timer no longer sends a Supabase API key. Supabase retires the legacy service_role key by the
-- end of 2026, and the new secret keys are not JWTs. The timer now sends its own random secret in the header
-- x-cron-secret. The value is read from the Vault secret cron_secret; the email-dispatch function compares it
-- with its function secret CRON_SECRET (DEPLOY.md step 7). The Vault secret service_role_key is no longer read.
-- Only the function changes; the pg_cron schedule from migration 07 calls it by name, so this file does not
-- need pg_cron and is safe to run again.

create or replace function public.invoke_email_dispatch() returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_url text; v_secret text;
begin
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    return;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1$q$ into v_secret;
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    raise warning 'email dispatch skipped: vault secrets project_url / cron_secret are missing';
    return;
  end if;
  execute $q$select net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 30000)$q$
    using rtrim(v_url, '/') || '/functions/v1/email-dispatch',
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
end $$;

revoke all on function public.invoke_email_dispatch() from public, anon, authenticated;
