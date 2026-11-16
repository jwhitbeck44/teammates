-- F5. recover-links writes its email_log row BEFORE sending, so parallel requests cannot exceed the limit.
-- 'pending' is the status of a row whose send has not finished (or was cut off).
alter table public.email_log drop constraint if exists email_log_status_check;
alter table public.email_log add constraint email_log_status_check check (status in ('pending', 'sent', 'failed', 'skipped'));

-- Reserves one recovery email: inserts a pending row and returns its id, or returns null when this
-- address already has p_limit recovery rows in the last hour, or all addresses together have p_global.
-- Rows of every status count. The advisory lock makes the count and the insert one step, so parallel
-- calls queue up instead of all passing the check.
create function public.claim_recovery_slot(p_email text, p_limit int, p_global int) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('claim_recovery_slot', 0));
  if (select count(*) from public.email_log where kind = 'recovery' and created_at > now() - interval '1 hour') >= p_global then
    return null;
  end if;
  if (select count(*) from public.email_log
       where kind = 'recovery' and to_email = p_email and created_at > now() - interval '1 hour') >= p_limit then
    return null;
  end if;
  insert into public.email_log (session_id, kind, to_email, student_id, status)
  values (null, 'recovery', p_email, null, 'pending') returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.claim_recovery_slot(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_recovery_slot(text, int, int) to service_role;
