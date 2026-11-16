-- Include each question's three visibility lists in the submission payload, so the form can tell
-- the giver who will see their answer. These are question settings, not response data.
create or replace function public.build_questions(p_session uuid, p_giver_type text, p_giver_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'number', q.number, 'type', q.type, 'brief', q.brief, 'description', q.description,
    'details', q.details, 'giver_type', q.giver_type, 'recipient_type', q.recipient_type,
    'max_recipients', q.max_recipients,
    'show_responses_to', to_jsonb(q.show_responses_to),
    'show_giver_name_to', to_jsonb(q.show_giver_name_to),
    'show_recipient_name_to', to_jsonb(q.show_recipient_name_to),
    'recipients', coalesce((select jsonb_agg(jsonb_build_object(
                     'recipient_key', r.recipient_key, 'display_name', r.display_name, 'team_key', r.team_key))
                   from public.question_recipients(q.id, p_giver_key) r), '[]'::jsonb),
    'answers', coalesce((select jsonb_agg(jsonb_build_object(
                     'recipient_key', x.recipient_key, 'answer', x.answer, 'giver_comment', x.giver_comment)
                     order by x.recipient_key)
                   from public.responses x where x.question_id = q.id and x.giver_key = p_giver_key), '[]'::jsonb)
  ) order by q.number), '[]'::jsonb)
  from public.questions q
  where q.session_id = p_session and q.giver_type = p_giver_type
$$;
