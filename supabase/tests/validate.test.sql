-- validate_answers for each of the 10 question types, and validate_question.
-- Giver is Alice (S1/T1); her teammates are Bob and Carol.
begin;
\ir seed.sql

create function t.ok_a(p_q uuid, p_answers jsonb, p_msg text) returns void language plpgsql as $$
begin
  perform t.lives(format('select public.validate_answers(%L, %L, %L::jsonb)', p_q, t.sk('Alice'), p_answers), p_msg);
end $$;
create function t.bad_a(p_q uuid, p_answers jsonb, p_code text, p_msg text) returns void language plpgsql as $$
begin
  perform t.throws(format('select public.validate_answers(%L, %L, %L::jsonb)', p_q, t.sk('Alice'), p_answers), p_code, p_msg);
end $$;
-- one self row (recipient = Alice)
create function t.me(p_answer text) returns jsonb language sql as $$ select jsonb_build_array(t.row(t.sk('Alice'), p_answer::jsonb)) $$;
-- rows for Bob and Carol
create function t.bc(p_a text, p_b text) returns jsonb language sql as $$
  select jsonb_build_array(t.row(t.sk('Bob'), p_a::jsonb), t.row(t.sk('Carol'), p_b::jsonb)) $$;

do $$
declare
  s uuid := t.mk_session('v', interval '-1 day', interval '1 day');
  q uuid;
begin
  -- ---------- general rules ----------
  q := t.mk_q(s, 1, 'text', 'own_team_members', '{}', 'students', '{}', '{}', '{}', 1);
  perform t.ok_a(q, '[]', 'text: empty array is valid (delete)');
  perform t.ok_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"text":"fine"}')), 'text: valid answer');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"text":"   "}')), 'empty_text', 'text: blank');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"text":5}')), 'invalid_answer', 'text: wrong shape');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Dave'), '{"text":"x"}')), 'not_a_recipient', 'text: recipient outside resolved list');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"text":"x"}')), 'not_a_recipient', 'text: self is not an own_team_members recipient');
  perform t.bad_a(q, t.bc('{"text":"x"}', '{"text":"y"}'), 'too_many_recipients', 'text: max_recipients 1 exceeded');
  perform t.bad_a(q, '{"a":1}', 'invalid_input', 'answers must be an array');
  perform t.bad_a(q, '[1]', 'invalid_input', 'rows must be objects');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"text":"x"}') || '{"giver_comment": 5}'), 'invalid_input', 'giver_comment must be a string');
  q := t.mk_q(s, 2, 'text', 'own_team_members');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"text":"x"}'), t.row(t.sk('Bob'), '{"text":"y"}')), 'duplicate_recipient', 'text: duplicate recipient');
  perform t.ok_a(q, t.bc('{"text":"x"}', '{"text":"y"}'), 'text: both teammates');
  perform t.throws(format('select public.validate_answers(%L, %L, %L::jsonb)', q, t.sk('Dave'), jsonb_build_array(t.row(t.sk('Alice'), '{"text":"x"}'))),
                   'not_a_recipient', 'resolution uses the giver key: Dave cannot answer for Alice');
  perform t.throws(format('select public.validate_answers(%L, %L, %L::jsonb)', q, 'i:' || gen_random_uuid()::text, jsonb_build_array(t.row(t.sk('Bob'), '{"text":"x"}'))),
                   'not_a_recipient', 'an instructor key is not a giver of a student question');

  -- ---------- mcq ----------
  q := t.mk_q(s, 3, 'mcq', 'self', '{"choices":["A","B","C"],"otherEnabled":true}');
  perform t.ok_a(q, t.me('{"choice":"B"}'), 'mcq: valid choice');
  perform t.ok_a(q, t.me('{"other":"something"}'), 'mcq: valid other');
  perform t.bad_a(q, t.me('{"choice":"Z"}'), 'not_a_choice', 'mcq: not a choice');
  perform t.bad_a(q, t.me('{"choice":"A","other":"x"}'), 'invalid_answer', 'mcq: both choice and other');
  perform t.bad_a(q, t.me('{}'), 'invalid_answer', 'mcq: neither');
  perform t.bad_a(q, t.me('{"other":"  "}'), 'empty_other', 'mcq: blank other');
  q := t.mk_q(s, 4, 'mcq', 'self', '{"choices":["A","B"],"otherEnabled":false}');
  perform t.bad_a(q, t.me('{"other":"x"}'), 'other_not_allowed', 'mcq: other not enabled');

  -- ---------- msq ----------
  q := t.mk_q(s, 5, 'msq', 'self', '{"choices":["a","b","c"],"otherEnabled":true,"minSelectable":1,"maxSelectable":2}');
  perform t.ok_a(q, t.me('{"choices":["a","c"]}'), 'msq: two choices');
  perform t.ok_a(q, t.me('{"choices":["a"],"other":"z"}'), 'msq: choice plus other');
  perform t.ok_a(q, t.me('{"choices":[]}'), 'msq: none of the above is allowed');
  perform t.bad_a(q, t.me('{"choices":["a","b","c"]}'), 'too_many_selected', 'msq: too many');
  perform t.bad_a(q, t.me('{"choices":["a","q"]}'), 'not_a_choice', 'msq: not a choice');
  perform t.bad_a(q, t.me('{"choices":["a","a"]}'), 'duplicate_choice', 'msq: duplicate');
  perform t.bad_a(q, t.me('{"choices":["a"],"other":" "}'), 'empty_other', 'msq: blank other');
  perform t.bad_a(q, t.me('{"choices":"a"}'), 'invalid_answer', 'msq: wrong shape');
  q := t.mk_q(s, 6, 'msq', 'self', '{"choices":["a","b","c"],"otherEnabled":false,"minSelectable":2}');
  perform t.bad_a(q, t.me('{"choices":["a"]}'), 'too_few_selected', 'msq: too few');
  perform t.bad_a(q, t.me('{"choices":["a","b"],"other":"x"}'), 'other_not_allowed', 'msq: other not enabled');

  -- ---------- numscale ----------
  q := t.mk_q(s, 7, 'numscale', 'self', '{"min":1,"max":5,"step":0.5}');
  perform t.ok_a(q, t.me('{"value":3.5}'), 'numscale: on step');
  perform t.ok_a(q, t.me('{"value":5}'), 'numscale: max');
  perform t.bad_a(q, t.me('{"value":5.5}'), 'out_of_range', 'numscale: above max');
  perform t.bad_a(q, t.me('{"value":0}'), 'out_of_range', 'numscale: below min');
  perform t.bad_a(q, t.me('{"value":2.3}'), 'not_on_step', 'numscale: off step');
  perform t.bad_a(q, t.me('{"value":"3"}'), 'invalid_answer', 'numscale: string');

  -- ---------- constsum_options ----------
  q := t.mk_q(s, 8, 'constsum_options', 'self', '{"options":["x","y","z"],"points":100,"pointsPerOption":false,"distribute":"some","minPoint":10,"maxPoint":80}');
  perform t.ok_a(q, t.me('{"points":[50,30,20]}'), 'constsum_options: valid');
  perform t.bad_a(q, t.me('{"points":[50,30,10]}'), 'sum_mismatch', 'constsum_options: wrong sum');
  perform t.bad_a(q, t.me('{"points":[50,30]}'), 'wrong_option_count', 'constsum_options: wrong length');
  perform t.bad_a(q, t.me('{"points":[110,-5,-5]}'), 'negative_points', 'constsum_options: negative');
  perform t.bad_a(q, t.me('{"points":[90,5,5]}'), 'below_min_point', 'constsum_options: below min');
  perform t.bad_a(q, t.me('{"points":[85,10,5]}'), 'below_min_point', 'constsum_options: below min (5)');
  perform t.bad_a(q, t.me('{"points":[85,15,0]}'), 'below_min_point', 'constsum_options: zero below min');
  perform t.bad_a(q, t.me('{"points":["a",1,2]}'), 'invalid_answer', 'constsum_options: not integers');
  q := t.mk_q(s, 9, 'constsum_options', 'self', '{"options":["x","y","z"],"points":100,"pointsPerOption":false,"distribute":"some","maxPoint":90}');
  perform t.bad_a(q, t.me('{"points":[95,5,0]}'), 'above_max_point', 'constsum_options: above max');
  perform t.bad_a(q, t.me('{"points":[0,100,0]}'), 'above_max_point', 'constsum_options: single 100 above max');
  q := t.mk_q(s, 10, 'constsum_options', 'self', '{"options":["x","y","z"],"points":10,"pointsPerOption":true,"distribute":"all"}');
  perform t.ok_a(q, t.me('{"points":[5,10,15]}'), 'constsum_options: points per option, all distinct');
  perform t.bad_a(q, t.me('{"points":[10,10,10]}'), 'not_all_distinct', 'constsum_options: all must differ');
  q := t.mk_q(s, 11, 'constsum_options', 'self', '{"options":["x","y"],"points":10,"pointsPerOption":false,"distribute":"some"}');
  perform t.bad_a(q, t.me('{"points":[5,5]}'), 'not_enough_distinct', 'constsum_options: some must differ');

  -- ---------- constsum_recipients (pool across the giver''s rows) ----------
  q := t.mk_q(s, 12, 'constsum_recipients', 'own_team_members', '{"points":100,"pointsPerOption":false,"distribute":"all"}');
  perform t.ok_a(q, t.bc('{"points":60}', '{"points":40}'), 'constsum_recipients: valid');
  perform t.bad_a(q, t.bc('{"points":60}', '{"points":30}'), 'sum_mismatch', 'constsum_recipients: wrong pool');
  perform t.bad_a(q, t.bc('{"points":50}', '{"points":50}'), 'not_all_distinct', 'constsum_recipients: duplicates');
  perform t.bad_a(q, t.bc('{"points":60}', '{"points":"x"}'), 'invalid_answer', 'constsum_recipients: wrong shape');
  q := t.mk_q(s, 13, 'constsum_recipients', 'own_team_members', '{"points":100,"pointsPerOption":true,"distribute":"none"}');
  perform t.ok_a(q, t.bc('{"points":120}', '{"points":80}'), 'constsum_recipients: per-recipient total is 100 x rows answered');
  perform t.ok_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"points":100}')), 'constsum_recipients: one row total 100');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"points":200}')), 'sum_mismatch', 'constsum_recipients: one row wrong total');

  -- ---------- contrib (zero-sum, Alice answers for T1: Alice, Bob, Carol) ----------
  q := t.mk_q(s, 14, 'contrib', 'own_team_members_including_self', '{"isZeroSum":true,"isNotSureAllowed":false}');
  perform t.ok_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":100}'), t.row(t.sk('Bob'), '{"value":110}'), t.row(t.sk('Carol'), '{"value":90}')), 'contrib: zero-sum valid');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":100}'), t.row(t.sk('Bob'), '{"value":110}')), 'contrib_all_required', 'contrib: zero-sum needs everyone');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":100}'), t.row(t.sk('Bob'), '{"value":110}'), t.row(t.sk('Carol'), '{"value":100}')), 'sum_mismatch', 'contrib: zero-sum wrong total');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":-101}'), t.row(t.sk('Bob'), '{"value":100}'), t.row(t.sk('Carol'), '{"value":100}')), 'invalid_contrib_value', 'contrib: not sure not allowed');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":205}'), t.row(t.sk('Bob'), '{"value":50}'), t.row(t.sk('Carol'), '{"value":45}')), 'out_of_range', 'contrib: above 200');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":103}'), t.row(t.sk('Bob'), '{"value":100}'), t.row(t.sk('Carol'), '{"value":97}')), 'not_on_step', 'contrib: not a step of 5');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":"x"}')), 'invalid_answer', 'contrib: wrong shape');
  q := t.mk_q(s, 15, 'contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":true}');
  perform t.ok_a(q, jsonb_build_array(t.row(t.sk('Alice'), '{"value":100}'), t.row(t.sk('Bob'), '{"value":-101}')), 'contrib: not zero-sum allows partial and not sure');

  -- ---------- rubric ----------
  q := t.mk_q(s, 16, 'rubric', 'self', '{"choices":["Good","Bad"],"subQuestions":["s1","s2"],"descriptions":[["",""],["",""]]}');
  perform t.ok_a(q, t.me('{"choices":[0,1]}'), 'rubric: valid');
  perform t.ok_a(q, t.me('{"choices":[-1,1]}'), 'rubric: one unanswered');
  perform t.bad_a(q, t.me('{"choices":[-1,-1]}'), 'no_rubric_answer', 'rubric: nothing answered');
  perform t.bad_a(q, t.me('{"choices":[0,2]}'), 'invalid_rubric_choice', 'rubric: index out of range');
  perform t.bad_a(q, t.me('{"choices":[0]}'), 'invalid_answer', 'rubric: wrong length');

  -- ---------- rank_options ----------
  q := t.mk_q(s, 17, 'rank_options', 'self', '{"options":["o1","o2","o3"],"minToRank":2,"duplicatesAllowed":false}');
  perform t.ok_a(q, t.me('{"ranks":[1,2,3]}'), 'rank_options: valid');
  perform t.ok_a(q, t.me('{"ranks":[2,null,1]}'), 'rank_options: blanks allowed above minimum');
  perform t.bad_a(q, t.me('{"ranks":[1,1,2]}'), 'duplicate_rank', 'rank_options: duplicates');
  perform t.bad_a(q, t.me('{"ranks":[1,null,null]}'), 'too_few_ranked', 'rank_options: below minToRank');
  perform t.bad_a(q, t.me('{"ranks":[null,null,null]}'), 'too_few_ranked', 'rank_options: nothing ranked');
  perform t.bad_a(q, t.me('{"ranks":[1,2,4]}'), 'rank_out_of_range', 'rank_options: rank above option count');
  perform t.bad_a(q, t.me('{"ranks":[1,2]}'), 'invalid_answer', 'rank_options: wrong length');
  q := t.mk_q(s, 18, 'rank_options', 'self', '{"options":["o1","o2","o3"],"maxToRank":1,"duplicatesAllowed":true}');
  perform t.bad_a(q, t.me('{"ranks":[1,2,null]}'), 'too_many_ranked', 'rank_options: above maxToRank');
  q := t.mk_q(s, 19, 'rank_options', 'self', '{"options":["o1","o2","o3"],"duplicatesAllowed":true}');
  perform t.ok_a(q, t.me('{"ranks":[1,1,1]}'), 'rank_options: duplicates allowed');

  -- ---------- rank_recipients ----------
  q := t.mk_q(s, 20, 'rank_recipients', 'own_team_members', '{"duplicatesAllowed":false}');
  perform t.ok_a(q, t.bc('{"rank":1}', '{"rank":2}'), 'rank_recipients: valid');
  perform t.bad_a(q, t.bc('{"rank":1}', '{"rank":1}'), 'duplicate_rank', 'rank_recipients: duplicates');
  perform t.bad_a(q, t.bc('{"rank":1}', '{"rank":3}'), 'rank_out_of_range', 'rank_recipients: above recipient count');
  perform t.bad_a(q, t.bc('{"rank":0}', '{"rank":1}'), 'rank_out_of_range', 'rank_recipients: zero');
  perform t.bad_a(q, t.bc('{"rank":"a"}', '{"rank":1}'), 'invalid_answer', 'rank_recipients: wrong shape');
  q := t.mk_q(s, 21, 'rank_recipients', 'own_team_members', '{"minToRank":2,"duplicatesAllowed":true}');
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"rank":1}')), 'too_few_ranked', 'rank_recipients: below minToRank');
  perform t.ok_a(q, t.bc('{"rank":1}', '{"rank":1}'), 'rank_recipients: duplicates allowed');
  q := t.mk_q(s, 22, 'rank_recipients', 'students', '{"maxToRank":2,"duplicatesAllowed":true}', 'students', '{}', '{}', '{}', 2);
  perform t.bad_a(q, jsonb_build_array(t.row(t.sk('Bob'), '{"rank":3}')), 'rank_out_of_range', 'rank_recipients: limit is min(max_recipients, recipients)');
end $$;

-- ---------- validate_question ----------
create function t.bad_q(p_type text, p_recip text, p_details jsonb, p_code text, p_msg text,
                        p_resp text[] default '{}', p_gname text[] default '{}', p_rname text[] default '{}',
                        p_giver text default 'students', p_brief text default 'B', p_max int default null) returns void
language plpgsql as $$
declare v_s uuid := (select id from public.sessions where name = 'v');
begin
  perform t.throws(format($f$insert into public.questions (session_id, number, type, brief, giver_type, recipient_type, details,
                         show_responses_to, show_giver_name_to, show_recipient_name_to, max_recipients)
                         values (%L, 99, %L, %L, %L, %L, %L, %L, %L, %L, %s)$f$,
                         v_s, p_type, p_brief, p_giver, p_recip, p_details, p_resp, p_gname, p_rname, coalesce(p_max::text, 'null')),
                   p_code, p_msg);
end $$;

do $$
begin
  perform t.bad_q('nope', 'self', '{}', 'invalid_type', 'unknown type');
  perform t.bad_q('text', 'self', '{}', 'brief_required', 'blank brief', p_brief => '  ');
  perform t.bad_q('text', 'self', '{}', 'invalid_giver_type', 'bad giver', p_giver => 'teams');
  perform t.bad_q('text', 'planets', '{}', 'invalid_recipient_type', 'bad recipient type');
  perform t.bad_q('text', 'own_team', '{}', 'invalid_path', 'instructor giver cannot use own_team', p_giver => 'instructors');
  perform t.bad_q('contrib', 'self', '{"isZeroSum":true,"isNotSureAllowed":false}', 'invalid_path', 'contrib only to own team incl. self');
  perform t.bad_q('rank_recipients', 'self', '{"duplicatesAllowed":false}', 'invalid_path', 'rank_recipients has no self');
  perform t.bad_q('constsum_recipients', 'none', '{"points":10,"pointsPerOption":false,"distribute":"none"}', 'invalid_path', 'constsum_recipients has no none');
  perform t.bad_q('text', 'self', '{"recommendedLength":0}', 'invalid_recommended_length', 'recommendedLength >= 1');
  perform t.bad_q('text', 'self', '{}', 'invalid_max_recipients', 'max_recipients >= 1', p_max => 0);
  perform t.bad_q('mcq', 'self', '{"choices":["a"],"otherEnabled":false}', 'too_few_choices', 'mcq needs two choices');
  perform t.bad_q('mcq', 'self', '{"choices":["a","a"],"otherEnabled":false}', 'duplicate_option', 'mcq duplicates');
  perform t.bad_q('mcq', 'self', '{"choices":["a"," "],"otherEnabled":false}', 'empty_choice', 'mcq blank choice');
  perform t.bad_q('mcq', 'self', '{"choices":["a","b"]}', 'invalid_input', 'mcq needs otherEnabled');
  perform t.bad_q('msq', 'self', '{"choices":["a","b","c"],"otherEnabled":false,"maxSelectable":4}', 'invalid_selectable_limits', 'msq max above options');
  perform t.bad_q('msq', 'self', '{"choices":["a","b","c"],"otherEnabled":false,"minSelectable":3,"maxSelectable":2}', 'invalid_selectable_limits', 'msq min above max');
  perform t.bad_q('numscale', 'self', '{"min":5,"max":1,"step":1}', 'invalid_scale', 'numscale min < max');
  perform t.bad_q('numscale', 'self', '{"min":1,"max":5,"step":0}', 'invalid_scale', 'numscale step > 0');
  perform t.bad_q('constsum_options', 'self', '{"options":["a","b"],"points":0,"pointsPerOption":false,"distribute":"none"}', 'invalid_points', 'constsum points >= 1');
  perform t.bad_q('constsum_options', 'self', '{"options":["a","b"],"points":10,"pointsPerOption":false,"distribute":"weird"}', 'invalid_distribute', 'constsum distribute');
  perform t.bad_q('constsum_options', 'self', '{"options":["a","b"],"points":10,"pointsPerOption":false,"distribute":"none","minPoint":8}', 'invalid_min_max_point', 'constsum min above floor(total/n)');
  perform t.bad_q('contrib', 'own_team_members_including_self', '{"isZeroSum":true,"isNotSureAllowed":true}', 'contrib_conflict', 'contrib: zero-sum and not-sure');
  perform t.bad_q('contrib', 'own_team_members_including_self', '{"isZeroSum":true,"isNotSureAllowed":false}', 'contrib_visibility_pair', 'contrib: recipient without giver team',
                  array['recipient']);
  perform t.bad_q('rubric', 'self', '{"choices":["a"],"subQuestions":["s"],"descriptions":[["x"]]}', 'invalid_rubric', 'rubric needs two choices');
  perform t.bad_q('rubric', 'self', '{"choices":["a","b"],"subQuestions":["s"],"descriptions":[["x"]]}', 'invalid_rubric', 'rubric description grid shape');
  perform t.bad_q('rank_options', 'self', '{"options":["a","b"],"duplicatesAllowed":false,"minToRank":3}', 'invalid_rank_limits', 'rank min above options');
  perform t.bad_q('text', 'self', '{}', 'invalid_visibility', 'unknown visibility value', array['everyone']);
  perform t.bad_q('text', 'self', '{}', 'invalid_visibility', 'giver name without response right', array['instructors'], array['recipient']);
  perform t.bad_q('text', 'self', '{}', 'invalid_visibility', 'duplicate visibility value', array['instructors','instructors']);
  perform t.lives($q$insert into public.questions (session_id, number, type, brief, giver_type, recipient_type, details, show_responses_to, show_giver_name_to, show_recipient_name_to)
         values ((select id from public.sessions where name = 'v'), 98, 'text', 'ok', 'instructors', 'students', '{}', '{instructors,recipient}', '{instructors}', '{instructors,recipient}')$q$,
         'a valid question inserts');
end $$;

-- changing a question's type, choices or path deletes its responses; recommendedLength and brief do not
do $$
declare
  s uuid := (select id from public.sessions where name = 'v');
  q uuid := (select id from public.questions where session_id = s and number = 3);
begin
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  values (s, q, t.sk('Alice'), t.sk('Alice'), '{"choice":"A"}');
  update public.questions set brief = 'new brief' where id = q;
  perform t.eq((select count(*)::text from public.responses where question_id = q), '1', 'brief change keeps responses');
  update public.questions set details = '{"choices":["A","B","C","D"],"otherEnabled":true}' where id = q;
  perform t.eq((select count(*)::text from public.responses where question_id = q), '0', 'choice change deletes responses');
  q := (select id from public.questions where session_id = s and number = 1);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  values (s, q, t.sk('Alice'), t.sk('Bob'), '{"text":"x"}');
  update public.questions set details = '{"recommendedLength":50}' where id = q;
  perform t.eq((select count(*)::text from public.responses where question_id = q), '1', 'recommendedLength change keeps responses');
  update public.questions set recipient_type = 'self' where id = q;
  perform t.eq((select count(*)::text from public.responses where question_id = q), '0', 'recipient type change deletes responses');
end $$;
rollback;
