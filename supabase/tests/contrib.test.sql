-- CONTRIB: every case of the TEAMMATES fixture, through the math functions and end to end.
\set ON_ERROR_STOP on
begin;
\ir seed.sql
\set fx `cat "$TESTS_DIR/fixtures/contrib_cases.json"`
create temp table fx as select :'fx'::jsonb as j;
grant select on fx to public;

-- float arrays compared with a tolerance
create function t.near(p_a jsonb, p_b jsonb) returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(p_a) = 'array' then
    if jsonb_array_length(p_a) <> jsonb_array_length(p_b) then return false; end if;
    return not exists (select 1 from jsonb_array_elements(p_a) with ordinality a(e, o)
                       join jsonb_array_elements(p_b) with ordinality b(e, o) using (o)
                       where not t.near(a.e, b.e));
  end if;
  return abs((p_a #>> '{}')::numeric - (p_b #>> '{}')::numeric) < 1e-6;
end $$;

-- 1. the 11 matrix cases through contrib_calc
do $$
declare c jsonb; n int; e jsonb; r jsonb; rows jsonb;
begin
  for c in select value from jsonb_array_elements((select j -> 'cases' from fx)) loop
    n := jsonb_array_length(c -> 'input');
    e := c -> 'expected';
    r := public.contrib_calc(c -> 'input');
    perform t.eq(r -> 'normalizedClaimed' #>> '{}', e -> 'normalizedClaimed' #>> '{}', (c ->> 'name') || ' normalizedClaimed');
    perform t.eq(r -> 'normalizedPeerContributionRatio' #>> '{}', e -> 'normalizedPeerContributionRatio' #>> '{}', (c ->> 'name') || ' normalizedPeerContributionRatio');
    perform t.eq(r -> 'normalizedAveragePerceived' #>> '{}', e -> 'normalizedAveragePerceived' #>> '{}', (c ->> 'name') || ' normalizedAveragePerceived');
    perform t.eq(r -> 'denormalizedAveragePerceived' #>> '{}', e -> 'denormalizedAveragePerceived' #>> '{}', (c ->> 'name') || ' denormalizedAveragePerceived');
  end loop;
end $$;

-- 2. helper-function cases
do $$
declare tst jsonb; c jsonb; f text; i jsonb; x jsonb; ex jsonb; got jsonb;
begin
  for tst in select value from jsonb_array_elements((select j -> 'other_tests' from fx)) loop
    for c in select value from jsonb_array_elements(tst -> 'cases') loop
      f := c ->> 'function'; i := c -> 'input'; ex := c -> 'expected';
      if f = 'normalizeValues' then
        got := to_jsonb(public.contrib_normalize(public.contrib_row(i -> 'input')));
        perform t.is_true(t.near(got, ex), (c ->> 'name') || ' normalizeValues');
      elsif f = 'TeamEvalResult.removeSelfRatings' then
        got := public.contrib_remove_self(i -> 'input');
        perform t.is_true(t.near(got, ex), (c ->> 'name') || ' removeSelfRatings');
      elsif f = 'TeamEvalResult.averageColumns' then
        got := to_jsonb(public.contrib_average_columns(i -> 'input'));
        perform t.is_true(t.near(got, ex), (c ->> 'name') || ' averageColumns');
      elsif f = 'TeamEvalResult.sum' then
        got := to_jsonb(public.contrib_sum(public.contrib_row(i -> 'input')));
        perform t.is_true(t.near(got, ex), (c ->> 'name') || ' sum');
      elsif f = 'TeamEvalResult.calculatePerceivedForStudent' then
        got := to_jsonb(public.contrib_perceived_for_student(public.contrib_row(i -> 'claimedSanitizedRow'),
                                                              public.contrib_row(i -> 'normalizedAveragePerceived')));
        perform t.is_true(t.near(got, ex), (c ->> 'name') || ' calculatePerceivedForStudent');
      elsif f = 'TeamEvalResult.isSanitized' then
        got := to_jsonb(public.contrib_is_sanitized(public.contrib_row(i -> 'array')));
        perform t.eq(got #>> '{}', ex #>> '{}', (c ->> 'name') || ' isSanitized');
      elsif f = 'purgeValuesCorrespondingToSpecialValuesInFilter' then
        got := to_jsonb(public.contrib_purge(public.contrib_row(i -> 'filterArray'), public.contrib_row(i -> 'valueArray')));
        perform t.is_true(t.near(got, ex), (c ->> 'name') || ' purge');
      else
        raise exception 'unknown fixture function %', f;
      end if;
    end loop;
  end loop;
end $$;

-- 3. end to end: responses in a real team, then contrib_team_result.
-- Team sizes in the seed: T3 has 1 member (Frank), T2 has 2 (Dave, Erin), T1 has 3, T4 has 4 (Gina, Hal, Ivy, Jon).
do $$
declare
  s uuid := t.mk_session('contrib', interval '-1 day', interval '1 day');
  q uuid := t.mk_q(s, 1, 'contrib', 'own_team_members_including_self',
                   '{"isZeroSum": false, "isNotSureAllowed": true}', 'students',
                   array['recipient','giver_team_members','instructors'], array['instructors'], array['instructors','recipient']);
  c jsonb; n int; names text[]; team text; r jsonb; g int; h int; v int; e jsonb; done int := 0;
begin
  for c in select value from jsonb_array_elements((select j -> 'cases' from fx)) loop
    n := jsonb_array_length(c -> 'input');
    -- -9999 in a raw input cannot come from a student, so those cases are covered by section 1 only
    if c -> 'input' #>> '{}' like '%-9999%' then continue; end if;
    names := case n when 1 then array['Frank'] when 2 then array['Dave','Erin']
                    when 3 then array['Alice','Bob','Carol'] else array['Gina','Hal','Ivy','Jon'] end;
    team := case n when 1 then 't:S2|T3' when 2 then 't:S1|T2' when 3 then 't:S1|T1' else 't:S2|T4' end;
    delete from public.responses where question_id = q;
    for g in 1..n loop
      for h in 1..n loop
        v := ((c -> 'input') -> (g - 1) ->> (h - 1))::int;
        if v <> -999 then
          insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
          values (s, q, t.sk(names[g]), t.sk(names[h]), jsonb_build_object('value', v));
        end if;
      end loop;
    end loop;
    r := public.contrib_team_result(q, team);
    e := c -> 'expected';
    perform t.eq(r -> 'claimed' #>> '{}', (c -> 'input') #>> '{}', (c ->> 'name') || ' e2e claimed matrix');
    perform t.eq(r -> 'normalizedClaimed' #>> '{}', e -> 'normalizedClaimed' #>> '{}', (c ->> 'name') || ' e2e normalizedClaimed');
    perform t.eq(r -> 'normalizedPeerContributionRatio' #>> '{}', e -> 'normalizedPeerContributionRatio' #>> '{}', (c ->> 'name') || ' e2e peer ratio');
    perform t.eq(r -> 'normalizedAveragePerceived' #>> '{}', e -> 'normalizedAveragePerceived' #>> '{}', (c ->> 'name') || ' e2e perceived');
    perform t.eq(r -> 'denormalizedAveragePerceived' #>> '{}', e -> 'denormalizedAveragePerceived' #>> '{}', (c ->> 'name') || ' e2e denormalized');
    done := done + 1;
  end loop;
  perform t.is_true(done >= 8, 'at least 8 fixture cases ran end to end (' || done || ')');
end $$;

-- 4. instructor_contrib_results output shape
do $$
declare
  s uuid := t.mk_session('contrib2', interval '-1 day', interval '1 day');
  q uuid := t.mk_q(s, 1, 'contrib', 'own_team_members_including_self',
                   '{"isZeroSum": true, "isNotSureAllowed": false}');
  r jsonb; a jsonb;
begin
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk(g), t.sk(r2), jsonb_build_object('value', v)
  from (values ('Alice','Alice',100),('Alice','Bob',100),('Alice','Carol',100),
               ('Bob','Alice',150),('Bob','Bob',100),('Bob','Carol',50),
               ('Carol','Alice',150),('Carol','Bob',50),('Carol','Carol',100)) x(g, r2, v);
  perform t.as_user(t.id('obs'), 'obs@a.edu');
  r := public.instructor_contrib_results(q);
  perform t.reset();
  select e into a from jsonb_array_elements(r -> 'students') e where e ->> 'name' = 'Alice';
  perform t.eq(a ->> 'claimed', '100', 'contrib results: Alice claimed');
  perform t.eq(a ->> 'perceived', '150', 'contrib results: Alice perceived');
  perform t.eq(a ->> 'diff', '50', 'contrib results: Alice diff');
  perform t.eq((a -> 'ratings_received') #>> '{}', '[150, 150]', 'contrib results: Alice ratings received');
  perform t.is_true(jsonb_array_length(r -> 'students') = 10, 'contrib results list every student of course A');
end $$;
rollback;
