-- claim_recovery_slot: per-address limit, global cap, pending rows count, service role only (review finding F5).
begin;
\ir seed.sql

select t.is_true(public.claim_recovery_slot('a@x.edu', 3, 5) is not null, 'first claim succeeds and returns an id');
select t.is_true(public.claim_recovery_slot('a@x.edu', 3, 5) is not null, 'second claim succeeds');
select t.is_true(public.claim_recovery_slot('a@x.edu', 3, 5) is not null, 'third claim succeeds');
select t.is_true(public.claim_recovery_slot('a@x.edu', 3, 5) is null, 'fourth claim for the same address is refused, although every row is still pending');
select t.eq((select count(*)::text from public.email_log where kind = 'recovery' and status = 'pending'), '3', 'the three claims are pending rows written before any send');
select t.is_true(public.claim_recovery_slot('b@x.edu', 3, 5) is not null, 'another address is not affected (global 4 of 5)');
select t.is_true(public.claim_recovery_slot('c@x.edu', 3, 5) is not null, 'global 5 of 5');
select t.is_true(public.claim_recovery_slot('d@x.edu', 3, 5) is null, 'the global cap refuses a new address');
select t.is_true(public.claim_recovery_slot('E@x.edu', 3, 100) is not null, 'the global cap is a parameter');
update public.email_log set created_at = now() - interval '61 minutes' where to_email = 'a@x.edu';
select t.is_true(public.claim_recovery_slot('a@x.edu', 3, 100) is not null, 'rows older than an hour no longer count');
update public.email_log set status = 'failed' where to_email = 'b@x.edu';
select t.is_true(public.claim_recovery_slot('b@x.edu', 1, 100) is null, 'failed rows count as well');
select t.eq((select count(*)::text from public.email_log where kind <> 'recovery'), '0', 'no other kind is written');

select t.throws('insert into public.email_log (kind, to_email, status) values (''recovery'', ''z@x.edu'', ''bogus'')', '23514', 'status is still constrained');

select t.as_anon();
select t.throws($$select public.claim_recovery_slot('a@x.edu', 3, 5)$$, '42501', 'anon cannot claim');
select t.reset();
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws($$select public.claim_recovery_slot('a@x.edu', 3, 5)$$, '42501', 'authenticated cannot claim');
select t.reset();
select t.as_service();
select t.lives($$select public.claim_recovery_slot('s@x.edu', 3, 100)$$, 'service_role can claim');
select t.reset();
rollback;
