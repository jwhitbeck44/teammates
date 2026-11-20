-- The cron migration is safe without pg_cron/pg_net, and invoke_email_dispatch reads Vault secrets.
-- run.sh skips migration 07 when pg_cron is absent but applies migration 12 (it only replaces the function).
-- This file applies 07 and then 12 again, so the function under test is the one from migration 12.
begin;
\ir seed.sql
-- apply the migrations on a database that may lack pg_cron: they must not fail
\ir ../migrations/20261116000007_cron.sql
\ir ../migrations/20261117000012_cron_secret.sql

select t.lives('select public.invoke_email_dispatch()', 'invoke_email_dispatch does nothing when pg_net and vault are missing');

-- stand-ins for pg_net and Vault
create schema net;
create table net.calls (url text, headers jsonb, body jsonb, timeout int);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as $$
  insert into net.calls values (url, headers, body, timeout_milliseconds) returning 1::bigint $$;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);

select t.lives('select public.invoke_email_dispatch()', 'missing secrets: no error');
select t.eq((select count(*)::text from net.calls), '0', 'missing secrets: no request sent');
-- the old secret alone is not enough: the timer no longer uses the service role key
insert into vault.decrypted_secrets values ('project_url', 'https://abc.supabase.co/'), ('service_role_key', 'KEY123');
select t.lives('select public.invoke_email_dispatch()', 'only the legacy service_role_key secret: no error');
select t.eq((select count(*)::text from net.calls), '0', 'only the legacy service_role_key secret: no request sent');
insert into vault.decrypted_secrets values ('cron_secret', 'CRON456');
select t.lives('select public.invoke_email_dispatch()', 'with secrets: runs');
select t.eq((select count(*)::text from net.calls), '1', 'with secrets: one request');
select t.eq((select url from net.calls), 'https://abc.supabase.co/functions/v1/email-dispatch', 'with secrets: calls the email-dispatch function URL');
select t.eq((select headers ->> 'x-cron-secret' from net.calls), 'CRON456', 'with secrets: cron secret in the x-cron-secret header');
select t.is_true((select not (headers ? 'Authorization') and not (headers ? 'apikey') from net.calls), 'no Supabase key is sent (no Authorization, no apikey header)');
select t.is_true((select position('KEY123' in headers::text) = 0 from net.calls), 'the legacy service role key is not sent anywhere');

select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws('select public.invoke_email_dispatch()', '42501', 'authenticated cannot run invoke_email_dispatch');
select t.reset();
select t.as_anon();
select t.throws('select public.invoke_email_dispatch()', '42501', 'anon cannot run invoke_email_dispatch');
select t.reset();
rollback;
