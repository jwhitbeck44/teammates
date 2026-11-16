-- student_get_results: visibility presets, anonymity, contrib, not_published.
-- Team T1 is Alice, Bob, Carol. Each question has: Alice>Bob "A>B", Carol>Bob "C>B", Bob>Alice "B>A".
begin;
\ir seed.sql

create table t.q (n int primary key, id uuid, s uuid);
grant select on t.q to public;

-- one row per visible response as "giver>recipient:answer", sorted, for one viewer and question number
create function t.view(p_viewer text, p_n int) returns text language plpgsql as $$
declare r jsonb; q jsonb; out text;
begin
  perform t.as_anon();
  r := public.student_get_results(t.tok(p_viewer), (select s from t.q where n = p_n));
  perform t.reset();
  select e into q from jsonb_array_elements(r -> 'questions') e where (e ->> 'number')::int = p_n;
  if q is null then return 'ABSENT'; end if;
  select string_agg((x ->> 'giver_name') || '>' || (x ->> 'recipient_name') || ':' || (x -> 'answer' ->> 'text'), ' | ' order by (x ->> 'giver_name') || '>' || (x ->> 'recipient_name') || ':' || (x -> 'answer' ->> 'text'))
    into out from jsonb_array_elements(q -> 'responses') x;
  return coalesce(out, 'EMPTY');
end $$;
create function t.raw(p_viewer text) returns text language plpgsql as $$
declare r jsonb;
begin
  perform t.as_anon();
  r := public.student_get_results(t.tok(p_viewer), (select s from t.q where n = 1));
  perform t.reset();
  return r::text;
end $$;

do $$
declare
  s uuid := t.mk_session('res', interval '-1 day', interval '1 day');
  presets text[][] := array[
    -- responses, giver names, recipient names (comma separated)
    ['instructors,recipient,giver_team_members', 'instructors', 'instructors,recipient'],  -- 1 preset 1
    ['recipient,instructors', 'instructors', 'recipient,instructors'],                     -- 2 preset 2
    ['recipient,instructors', 'recipient,instructors', 'recipient,instructors'],           -- 3 preset 3
    ['instructors', 'instructors', 'instructors'],                                         -- 4 preset 4
    ['students', '', 'students'],                                                          -- 5 custom
    ['giver_team_members', 'giver_team_members', '']                                       -- 6 custom
  ];
  i int; q uuid;
begin
  for i in 1..6 loop
    q := t.mk_q(s, i, 'text', 'own_team_members', '{}', 'students',
                string_to_array(presets[i][1], ','), case when presets[i][2] = '' then '{}' else string_to_array(presets[i][2], ',') end,
                case when presets[i][3] = '' then '{}' else string_to_array(presets[i][3], ',') end);
    insert into t.q values (i, q, s);
    insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values
      (s, q, t.sk('Alice'), t.sk('Bob'), '{"text":"A>B"}'),
      (s, q, t.sk('Carol'), t.sk('Bob'), '{"text":"C>B"}'),
      (s, q, t.sk('Bob'), t.sk('Alice'), '{"text":"B>A"}');
  end loop;
  -- 7: teams, Dave answers for team T1; visible to the recipient (team members) and instructors
  q := t.mk_q(s, 7, 'text', 'teams', '{}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
  insert into t.q values (7, q, s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values (s, q, t.sk('Dave'), 't:S1|T1', '{"text":"D>T1"}');
  -- 8: recipient_team_members only
  q := t.mk_q(s, 8, 'text', 'students', '{}', 'students', array['recipient_team_members'], '{}', '{}');
  insert into t.q values (8, q, s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values (s, q, t.sk('Dave'), t.sk('Alice'), '{"text":"D>A"}');
  -- 9: contrib, visible to recipient and giver team
  q := t.mk_q(s, 9, 'contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":false}', 'students',
              array['instructors','recipient','giver_team_members'], array['instructors'], array['instructors','recipient']);
  insert into t.q values (9, q, s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk(g), t.sk(r), jsonb_build_object('value', v)
  from (values ('Alice','Alice',100),('Alice','Bob',100),('Alice','Carol',100),
               ('Bob','Alice',150),('Bob','Bob',100),('Bob','Carol',50),
               ('Carol','Alice',150),('Carol','Bob',50),('Carol','Carol',100)) x(g, r, v);
  -- 10: contrib visible to instructors only
  q := t.mk_q(s, 10, 'contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":false}', 'students',
              array['instructors'], array['instructors'], array['instructors']);
  insert into t.q values (10, q, s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk('Alice'), t.sk('Bob'), '{"value":100}';
  update public.sessions set published_at = now(), closes_at = now() - interval '1 hour' where id = s;  -- closed for everyone, so CONTRIB numbers show
end $$;

-- ---------- preset 1: anonymous to recipient and giver's team, visible to instructors ----------
select t.eq(t.view('Bob', 1), 'Anonymous>Bob:A>B | Anonymous>Bob:C>B | Bob>Alice:B>A', 'preset 1, recipient Bob: givers anonymous, own response named');
select t.eq(t.view('Alice', 1), 'Alice>Bob:A>B | Anonymous>Alice:B>A | Anonymous>Anonymous:C>B', 'preset 1, Alice: own full, others anonymous, recipient hidden unless she is the recipient');
select t.eq(t.view('Dave', 1), 'ABSENT', 'preset 1, other team: nothing');

-- ---------- preset 2: anonymous to recipient, visible to instructors ----------
select t.eq(t.view('Bob', 2), 'Anonymous>Bob:A>B | Anonymous>Bob:C>B | Bob>Alice:B>A', 'preset 2, Bob');
select t.eq(t.view('Alice', 2), 'Alice>Bob:A>B | Anonymous>Alice:B>A', 'preset 2, Alice sees what she gave and what she received');
select t.eq(t.view('Carol', 2), 'Carol>Bob:C>B', 'preset 2, Carol sees only her own');
select t.eq(t.view('Dave', 2), 'ABSENT', 'preset 2, Dave');

-- ---------- preset 3: visible to recipient and instructors ----------
select t.eq(t.view('Bob', 3), 'Alice>Bob:A>B | Bob>Alice:B>A | Carol>Bob:C>B', 'preset 3, Bob sees names');
select t.eq(t.view('Alice', 3), 'Alice>Bob:A>B | Bob>Alice:B>A', 'preset 3, Alice');
select t.eq(t.view('Carol', 3), 'Carol>Bob:C>B', 'preset 3, Carol');

-- ---------- preset 4: instructors only ----------
select t.eq(t.view('Bob', 4), 'Bob>Alice:B>A', 'preset 4, Bob sees only his own');
select t.eq(t.view('Carol', 4), 'Carol>Bob:C>B', 'preset 4, Carol sees only her own');
select t.eq(t.view('Dave', 4), 'ABSENT', 'preset 4, Dave');

-- ---------- custom ----------
select t.eq(t.view('Dave', 5), 'Anonymous>Alice:B>A | Anonymous>Bob:A>B | Anonymous>Bob:C>B', 'custom: any student sees responses, recipient names shown, givers anonymous');
select t.eq(t.view('Carol', 6), 'Alice>Anonymous:A>B | Bob>Anonymous:B>A | Carol>Bob:C>B', 'custom giver_team_members: names shown to the giver team, recipients hidden unless own');
select t.eq(t.view('Bob', 6), 'Alice>Bob:A>B | Bob>Alice:B>A | Carol>Bob:C>B', 'custom giver_team_members: the recipient always sees the recipient name');
select t.eq(t.view('Dave', 6), 'ABSENT', 'custom giver_team_members: other team sees nothing');

-- team recipient and recipient_team_members
select t.eq(t.view('Alice', 7), 'Anonymous>T1:D>T1', 'team recipient: team members see it, giver anonymous');
select t.eq(t.view('Dave', 7), 'Dave>T1:D>T1', 'team recipient: the giver sees it with names');
select t.eq(t.view('Erin', 7), 'ABSENT', 'team recipient: nobody else');
select t.eq(t.view('Carol', 8), 'Anonymous>Anonymous:D>A', 'recipient_team_members: Alice''s teammate sees it anonymously');
select t.eq(t.view('Alice', 8), 'Anonymous>Alice:D>A', 'recipient_team_members: recipient sees own name');
select t.eq(t.view('Erin', 8), 'ABSENT', 'recipient_team_members: unrelated student');

-- ---------- nothing identifying leaks ----------
select t.is_true(t.raw('Bob') !~ t.id('Alice')::text and t.raw('Bob') !~ t.id('Carol')::text, 'results hold no uuid of another student');
select t.is_true(t.raw('Bob') !~ '@s\.edu', 'results hold no email');
select t.is_true(t.raw('Bob') !~ 'giver_key|recipient_key|access_token', 'results hold no key fields');
select t.is_true(t.raw('Dave') !~ t.id('Alice')::text, 'Dave''s results hold no uuid of Alice');
select t.is_true((select bool_and((x ->> 'giver_name') = 'Anonymous')
                  from jsonb_array_elements((public.student_get_results(t.tok('Bob'), (select s from t.q where n = 2)) -> 'questions' -> 0) -> 'responses') x
                  where not (x ->> 'is_own')::boolean), 'every non-own giver name is Anonymous (preset 2)') ;

-- is_own and recipient_is_me flags
select t.as_anon();
select t.eq((select count(*)::text from jsonb_array_elements((public.student_get_results(t.tok('Bob'), (select s from t.q where n = 1)) -> 'questions' -> 0) -> 'responses') x where (x ->> 'is_own')::boolean), '1', 'exactly one own response for Bob');
select t.eq((select count(*)::text from jsonb_array_elements((public.student_get_results(t.tok('Bob'), (select s from t.q where n = 1)) -> 'questions' -> 0) -> 'responses') x where (x ->> 'recipient_is_me')::boolean), '2', 'two responses about Bob');
select t.reset();

-- ---------- can_view on raw rows ----------
select t.eq((select sees_response::text || sees_giver_name::text || sees_recipient_name::text from public.can_view(
   (select id from t.q where n = 1), (select id from public.responses where question_id = (select id from t.q where n = 1) and giver_key = t.sk('Alice')), t.id('Bob'))), 'truefalsetrue', 'can_view preset 1: recipient sees response and own name, not giver');
select t.eq((select sees_response::text || sees_giver_name::text || sees_recipient_name::text from public.can_view(
   (select id from t.q where n = 1), (select id from public.responses where question_id = (select id from t.q where n = 1) and giver_key = t.sk('Alice')), t.id('Carol'))), 'truefalsefalse', 'can_view preset 1: giver teammate sees response only');
select t.eq((select sees_response::text || sees_giver_name::text || sees_recipient_name::text from public.can_view(
   (select id from t.q where n = 1), (select id from public.responses where question_id = (select id from t.q where n = 1) and giver_key = t.sk('Alice')), t.id('Dave'))), 'falsefalsefalse', 'can_view preset 1: other team sees nothing');
select t.eq((select sees_response::text || sees_giver_name::text || sees_recipient_name::text from public.can_view(
   (select id from t.q where n = 1), (select id from public.responses where question_id = (select id from t.q where n = 1) and giver_key = t.sk('Alice')), t.id('Alice'))), 'truetruetrue', 'can_view: the giver sees everything of their own');

-- ---------- contrib ----------
do $$
declare r jsonb; c jsonb;
begin
  perform t.as_anon();
  r := public.student_get_results(t.tok('Alice'), (select s from t.q where n = 9));
  perform t.reset();
  select e into c from jsonb_array_elements(r -> 'questions') e where e ->> 'number' = '9';
  perform t.is_true(c is not null, 'contrib: question present for a recipient');
  perform t.eq(c -> 'responses' #>> '{}', '[]', 'contrib: no individual responses');
  perform t.eq(c #>> '{contrib,my_claim,own}', '100', 'contrib: Alice claim of self');
  perform t.eq(c #>> '{contrib,my_claim,others}', '[100, 100]', 'contrib: Alice claims on others');
  perform t.eq(c #>> '{contrib,team_view_of_me,own}', '150', 'contrib: team view of Alice');
  perform t.is_true(not (c -> 'contrib' -> 'team_view_of_me' ? 'others'), 'contrib: the team view of the teammates is not returned (F4)');
  perform t.is_true(c::text !~ '"answer"' and c::text !~ t.id('Bob')::text, 'contrib: nothing individual or identifying');
  perform t.as_anon();
  r := public.student_get_results(t.tok('Bob'), (select s from t.q where n = 9));
  perform t.reset();
  select e into c from jsonb_array_elements(r -> 'questions') e where e ->> 'number' = '9';
  perform t.eq(c #>> '{contrib,my_claim,own}', '100', 'contrib: Bob own claim');
  perform t.eq(c #>> '{contrib,my_claim,others}', '[150, 50]', 'contrib: Bob claims on others, descending');
  perform t.as_anon();
  r := public.student_get_results(t.tok('Dave'), (select s from t.q where n = 9));
  perform t.reset();
  perform t.is_true(not exists (select 1 from jsonb_array_elements(r -> 'questions') e where e ->> 'number' in ('9', '10')), 'contrib: absent for a team with no answers and for instructor-only visibility');
  perform t.as_anon();
  r := public.student_get_results(t.tok('Alice'), (select s from t.q where n = 10));
  perform t.reset();
  perform t.is_true(not exists (select 1 from jsonb_array_elements(r -> 'questions') e where e ->> 'number' = '10'), 'contrib visible to instructors only: hidden from the team');
end $$;

-- ---------- not published ----------
select t.mk_session('unpub', interval '-1 day', interval '1 day') as x \gset
select t.mk_session('atopen', interval '-1 day', interval '1 day', 15, 'at_open') as y \gset
insert into t.q values (11, gen_random_uuid(), :'x'), (12, gen_random_uuid(), :'y');
select t.as_anon();
select t.throws(format('select public.student_get_results(%L, %L)', t.tok('Alice'), (select s from t.q where n = 11)), 'not_published', 'unpublished session raises not_published');
select t.lives(format('select public.student_get_results(%L, %L)', t.tok('Alice'), (select s from t.q where n = 12)), 'at_open session is readable');
select t.reset();
rollback;
