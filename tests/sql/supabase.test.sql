-- Tests for reference/supabase.sql on the Supabase Postgres image, which has
-- the real anon / authenticated roles and auth.uid() / auth.jwt().
\set ON_ERROR_STOP on
set client_min_messages = warning;

create function pg_temp.expect_error(p_sql text, p_msg text) returns void
language plpgsql as $$
declare
  v_ok boolean := false;
begin
  begin
    execute p_sql;
    v_ok := true;
  exception when others then
    if sqlerrm <> p_msg then
      raise exception 'expected "%", got "%" from: %', p_msg, sqlerrm, p_sql;
    end if;
  end;
  if v_ok then
    raise exception 'expected "%" but it succeeded: %', p_msg, p_sql;
  end if;
end $$;

create function pg_temp.expect_state(p_sql text, p_state text) returns void
language plpgsql as $$
declare
  v_ok boolean := false;
begin
  begin
    execute p_sql;
    v_ok := true;
  exception when others then
    if sqlstate <> p_state then
      raise exception 'expected SQLSTATE %, got % (%) from: %', p_state, sqlstate, sqlerrm, p_sql;
    end if;
  end;
  if v_ok then
    raise exception 'expected SQLSTATE % but it succeeded: %', p_state, p_sql;
  end if;
end $$;

create function pg_temp.check(p_ok boolean, p_what text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAILED: %', p_what;
  end if;
end $$;

grant execute on all functions in schema pg_temp to anon, authenticated;

-- ── anonymous visitor ───────────────────────────────────────────────────────
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);

select pg_temp.check(
  public.submit_feedback('feature', 'Anon idea', null, 'browser_session_0001') is not null,
  'anon can submit with a session key');
select pg_temp.expect_error($$select public.submit_feedback('feature','Anon idea')$$, 'invalid_session');
select pg_temp.expect_error($$select public.submit_feedback('feature','Anon idea',null,'short')$$, 'invalid_session');
select pg_temp.check((select count(*) = 1 from public.list_feedback()), 'anon can list');
select pg_temp.check((select my_vote = 0 from public.list_feedback() limit 1), 'anon has no vote');

select pg_temp.expect_state($$select * from public.vote_feedback((select id from public.list_feedback() limit 1), 1)$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_items$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_votes$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_list('someone-else')$$, '42501');
select pg_temp.expect_state($$select public.feedback_submit('spoof','spoof','bug','Spoofed author')$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_vote('spoof', gen_random_uuid(), 1)$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_vote_gated('spoof', gen_random_uuid(), 1, array['b'])$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_cast_vote('spoof', gen_random_uuid(), 1, null, false)$$, '42501');
select pg_temp.expect_state($$select public.feedback_set_status(gen_random_uuid(), 'shipped')$$, '42501');
reset role;

-- ── signed-in member ────────────────────────────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);

do $$
declare
  v_item uuid := (select id from public.list_feedback() limit 1);
  r record;
begin
  select * into r from public.vote_feedback(v_item, 1);
  perform pg_temp.check(r.score = 1 and r.my_vote = 1, 'member vote counts');
  perform pg_temp.check(
    (select my_vote = 1 from public.list_feedback() where id = v_item),
    'list shows the member''s own vote');
  select * into r from public.vote_feedback(v_item, 1);
  perform pg_temp.check(r.score = 0 and r.my_vote = 0, 'second tap clears');
  perform public.vote_feedback(v_item, 1);
end $$;

select pg_temp.check(
  public.submit_feedback('bug', 'Member bug') is not null,
  'member can submit without a session key');
select pg_temp.expect_state($$update public.feedback_items set status = 'shipped'$$, '42501');
select pg_temp.expect_state($$delete from public.feedback_votes$$, '42501');
select pg_temp.expect_state($$select public.feedback_set_status(gen_random_uuid(), 'shipped')$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_vote('spoof', gen_random_uuid(), 1)$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_vote_gated('spoof', gen_random_uuid(), 1, array['b'])$$, '42501');
reset role;

-- ── Supabase anonymous sign-in counts as signed out for voting ──────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":true}', false);
select pg_temp.expect_error(
  $$select * from public.vote_feedback((select id from public.list_feedback() limit 1), 1)$$, 'not_signed_in');
reset role;

-- ── owner closes the loop ───────────────────────────────────────────────────
select public.feedback_set_status(
  (select id from public.feedback_items where title = 'Anon idea'), 'shipped', 'Live now');

set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select pg_temp.check(
  (select status = 'shipped' and admin_note = 'Live now' and score = 1
     from public.list_feedback() where title = 'Anon idea'),
  'anon sees the shipped status, note, and score');
reset role;

\echo 'supabase.sql: all checks passed'
