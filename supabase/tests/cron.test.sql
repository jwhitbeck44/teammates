-- The cron migration is safe without pg_cron/pg_net, and invoke_email_dispatch reads Vault secrets.
begin;
\ir seed.sql
-- apply the migration on a database that may lack pg_cron: it must not fail
\ir ../migrations/20261116000007_cron.sql

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
insert into vault.decrypted_secrets values ('project_url', 'https://abc.supabase.co/'), ('service_role_key', 'KEY123');
select t.lives('select public.invoke_email_dispatch()', 'with secrets: runs');
select t.eq((select url from net.calls), 'https://abc.supabase.co/functions/v1/email-dispatch', 'with secrets: calls the email-dispatch function URL');
select t.eq((select headers ->> 'Authorization' from net.calls), 'Bearer KEY123', 'with secrets: service role key in the Authorization header');

select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws('select public.invoke_email_dispatch()', '42501', 'authenticated cannot run invoke_email_dispatch');
select t.reset();
select t.as_anon();
select t.throws('select public.invoke_email_dispatch()', '42501', 'anon cannot run invoke_email_dispatch');
select t.reset();
rollback;
