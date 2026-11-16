-- Calls the email-dispatch Edge Function every 15 minutes through pg_net. The project URL and
-- service role key are read from Supabase Vault secrets named project_url and service_role_key.
-- Does nothing when pg_cron or pg_net is not available. Re-running is safe.

create or replace function public.invoke_email_dispatch() returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_url text; v_key text;
begin
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    return;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1$q$ into v_key;
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    raise warning 'email dispatch skipped: vault secrets project_url / service_role_key are missing';
    return;
  end if;
  execute $q$select net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 30000)$q$
    using rtrim(v_url, '/') || '/functions/v1/email-dispatch',
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key);
end $$;

revoke all on function public.invoke_email_dispatch() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;
    perform cron.schedule('email-dispatch', '*/15 * * * *', 'select public.invoke_email_dispatch()');
  else
    raise notice 'pg_cron or pg_net not available: email-dispatch schedule not created';
  end if;
end $$;
