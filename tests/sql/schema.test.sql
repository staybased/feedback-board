-- Tests for reference/schema.sql. Run by tests/sql/run.sh on a throwaway
-- Postgres. Every check raises on failure, and psql stops on the first error.
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- expect_error: the statement must fail with exactly this message.
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

-- expect_state: the statement must fail with this SQLSTATE (42501 = denied).
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

-- ── submit ──────────────────────────────────────────────────────────────────
do $$
declare
  v_id uuid;
begin
  v_id := public.feedback_submit('u1', 'user:u1', 'feature', '  Dark mode  ', '  please  ');
  perform pg_temp.check(
    (select status = 'open' and title = 'Dark mode' and body = 'please' and author_id = 'u1'
       from public.feedback_items where id = v_id),
    'submit trims input and stores the item as open');

  v_id := public.feedback_submit(null, 'anon:abc', 'bug', 'Button broken', '   ');
  perform pg_temp.check(
    (select author_id is null and body is null from public.feedback_items where id = v_id),
    'anonymous submit stores null author and blank body as null');
end $$;

select pg_temp.expect_error($$select public.feedback_submit('u1','user:u1','spam','Valid title')$$, 'invalid_kind');
select pg_temp.expect_error($$select public.feedback_submit('u1','user:u1',null,'Valid title')$$, 'invalid_kind');
select pg_temp.expect_error($$select public.feedback_submit('u1','user:u1','bug','ok')$$, 'invalid_title');
select pg_temp.expect_error($$select public.feedback_submit('u1','user:u1','bug','   ab   ')$$, 'invalid_title');
select pg_temp.expect_error(format($$select public.feedback_submit('u1','user:u1','bug',%L)$$, E'\n\n\t\n'), 'invalid_title');
do $$
declare
  v_id uuid := public.feedback_submit('u1', 'user:u1-ws', 'bug', E'\n\tTabs and newlines\n');
begin
  perform pg_temp.check(
    (select title = 'Tabs and newlines' from public.feedback_items where id = v_id),
    'titles are trimmed of all whitespace, not just spaces');
end $$;
select pg_temp.expect_error(format($$select public.feedback_submit('u1','user:u1','bug',%L)$$, repeat('x', 121)), 'invalid_title');
select pg_temp.expect_error(format($$select public.feedback_submit('u1','user:u1','bug','Valid title',%L)$$, repeat('x', 2001)), 'invalid_body');
select pg_temp.expect_error($$select public.feedback_submit('u1','','bug','Valid title')$$, 'invalid_rate_key');

-- ── rate limit: 5 per key per hour ──────────────────────────────────────────
do $$
begin
  for i in 1..5 loop
    perform public.feedback_submit('u9', 'user:u9', 'feature', 'Idea number ' || i);
  end loop;
end $$;
select pg_temp.expect_error($$select public.feedback_submit('u9','user:u9','feature','Idea six')$$, 'rate_limited');
select pg_temp.check(public.feedback_submit('u8', 'user:u8', 'feature', 'Another key') is not null,
  'a different rate key is not limited');
-- Items older than an hour stop counting.
update public.feedback_items set created_at = now() - interval '61 minutes' where rate_key = 'user:u9';
select pg_temp.check(public.feedback_submit('u9', 'user:u9', 'feature', 'Idea six') is not null,
  'rate limit window slides after an hour');

-- ── vote toggle ─────────────────────────────────────────────────────────────
do $$
declare
  v_item uuid := public.feedback_submit('u1', 'user:u1-vote', 'feature', 'Vote target');
  r record;
begin
  select * into r from public.feedback_vote('a', v_item, 1);
  perform pg_temp.check(r.score = 1 and r.my_vote = 1, 'first up vote counts');
  select * into r from public.feedback_vote('a', v_item, 1);
  perform pg_temp.check(r.score = 0 and r.my_vote = 0, 'pressing up again clears the vote');
  select * into r from public.feedback_vote('a', v_item, -1);
  perform pg_temp.check(r.score = -1 and r.my_vote = -1, 'down vote counts');
  select * into r from public.feedback_vote('a', v_item, 1);
  perform pg_temp.check(r.score = 1 and r.my_vote = 1, 'switching down to up replaces the vote');
  select * into r from public.feedback_vote('b', v_item, 1);
  perform pg_temp.check(r.score = 2 and r.my_vote = 1, 'a second voter adds to the score');
  perform pg_temp.check(
    (select count(*) = 2 from public.feedback_votes where item_id = v_item),
    'one row per voter per item');
end $$;

select pg_temp.expect_error($$select * from public.feedback_vote(null, gen_random_uuid(), 1)$$, 'not_signed_in');
select pg_temp.expect_error($$select * from public.feedback_vote('', gen_random_uuid(), 1)$$, 'not_signed_in');
select pg_temp.expect_error($$select * from public.feedback_vote('a', gen_random_uuid(), 1)$$, 'not_found');
select pg_temp.expect_error(
  $$select * from public.feedback_vote('a', (select id from public.feedback_items limit 1), 0)$$, 'invalid_vote');
select pg_temp.expect_error(
  $$select * from public.feedback_vote('a', (select id from public.feedback_items limit 1), 2)$$, 'invalid_vote');

-- ── list: ranking, my_vote, and nothing private ─────────────────────────────
do $$
declare
  v_low  uuid := public.feedback_submit('u2', 'user:u2', 'bug', 'Rank low');
  v_high uuid := public.feedback_submit('u2', 'user:u2', 'bug', 'Rank high');
  v_top  record;
  v_mine int;
  v_prev int := 2147483647;
  r record;
begin
  perform public.feedback_vote(v, v_high, 1) from unnest(array['r1','r2','r3','r4','r5','r6']) v;
  perform public.feedback_vote('r1', v_low, -1);

  select * into v_top from public.feedback_list('r1') limit 1;
  perform pg_temp.check(v_top.id = v_high and v_top.score = 6 and v_top.upvotes = 6,
    'highest score is listed first');

  select my_vote into v_mine from public.feedback_list('r1') where id = v_low;
  perform pg_temp.check(v_mine = -1, 'my_vote reflects the viewer''s own vote');
  select my_vote into v_mine from public.feedback_list(null) where id = v_low;
  perform pg_temp.check(v_mine = 0, 'signed-out viewers see my_vote = 0');
  select downvotes into v_mine from public.feedback_list(null) where id = v_low;
  perform pg_temp.check(v_mine = 1, 'downvotes are counted');

  for r in select score from public.feedback_list(null) loop
    perform pg_temp.check(r.score <= v_prev, 'list is sorted by score, highest first');
    v_prev := r.score;
  end loop;
end $$;

select pg_temp.check(
  not exists (
    select 1 from pg_proc p, unnest(p.proargnames) a
    where p.proname = 'feedback_list' and a in ('author_id', 'rate_key', 'voter_id', 'ballot')),
  'feedback_list exposes no author, rate key, voter, or ballot column');

-- ── token ballots (gated boards) ────────────────────────────────────────────
do $$
declare
  v_item uuid := public.feedback_submit('u3', 'user:u3', 'feature', 'Holder vote');
  r record;
begin
  -- Wallet A votes with token 5.
  perform public.feedback_vote_gated('0xa', v_item, 1, array['1:0xnft:5']);
  perform pg_temp.check(
    (select ballot = '1:0xnft:5' from public.feedback_votes where item_id = v_item and voter_id = '0xa'),
    'the vote records the token that backed it');

  -- B holds tokens 6 and 7: the first one unused on this item is picked.
  perform public.feedback_vote_gated('0xb', v_item, 1, array['1:0xnft:6', '1:0xnft:7']);
  perform pg_temp.check(
    (select ballot = '1:0xnft:6' from public.feedback_votes where item_id = v_item and voter_id = '0xb'),
    'the first token unused on this item backs the vote');

  -- A switches to down while still holding token 5: same ballot is kept.
  perform public.feedback_vote_gated('0xa', v_item, -1, array['1:0xnft:8', '1:0xnft:5']);
  perform pg_temp.check(
    (select ballot = '1:0xnft:5' and value = -1 from public.feedback_votes where item_id = v_item and voter_id = '0xa'),
    'switching keeps the ballot the voter still holds');

  -- A sold token 5 and now holds token 8: switching moves the vote onto 8.
  perform public.feedback_vote_gated('0xa', v_item, 1, array['1:0xnft:8']);
  perform pg_temp.check(
    (select ballot = '1:0xnft:8' and value = 1 from public.feedback_votes where item_id = v_item and voter_id = '0xa'),
    'switching moves the vote to a token the voter holds now');

  -- Token 5 is free again: C (its new holder) can use it.
  perform public.feedback_vote_gated('0xc', v_item, 1, array['1:0xnft:5']);
  select * into r from public.feedback_list(null) where id = v_item;
  perform pg_temp.check(r.score = 3, 'three tokens, three votes');

  -- C sends token 5 to D. D votes with it: C's vote no longer counts,
  -- D's does. One token, one vote, and the current holder's vote wins.
  perform public.feedback_vote_gated('0xd', v_item, 1, array['1:0xnft:5']);
  perform pg_temp.check(
    not exists (select 1 from public.feedback_votes where item_id = v_item and voter_id = '0xc'),
    'the stale vote from the previous holder is removed');
  perform pg_temp.check(
    (select ballot = '1:0xnft:5' from public.feedback_votes where item_id = v_item and voter_id = '0xd'),
    'the current holder''s vote takes the token');
  select * into r from public.feedback_list(null) where id = v_item;
  perform pg_temp.check(r.score = 3, 'passing a token along never adds a vote');

  -- D sells token 5 and holds nothing. D can still take the vote back...
  select * into r from public.feedback_vote_gated('0xd', v_item, 1, array[]::text[]);
  perform pg_temp.check(r.my_vote = 0 and r.score = 2, 'an ex-holder can clear their vote');
  -- ...but cannot cast a new one.
  perform pg_temp.expect_error(
    format($q$select * from public.feedback_vote_gated('0xd', %L, -1, array[]::text[])$q$, v_item), 'not_eligible');
  perform pg_temp.expect_error(
    format($q$select * from public.feedback_vote_gated('0xd', %L, 1, null)$q$, v_item), 'not_eligible');

  -- A ballot is per item: token 5 can back a vote on another item.
  perform public.feedback_vote_gated('0xe', public.feedback_submit('u3', 'user:u3', 'bug', 'Other item'), 1, array['1:0xnft:5']);

  -- A whale with many tokens in one wallet still has one vote per item.
  select * into r from public.feedback_vote_gated('0xwhale', v_item, 1, array['1:0xnft:20', '1:0xnft:21', '1:0xnft:22']);
  perform pg_temp.check(r.score = 3 and r.my_vote = 1, 'one vote per wallet, however many tokens it holds');
end $$;

-- ── status ──────────────────────────────────────────────────────────────────
do $$
declare
  v_item uuid := public.feedback_submit('u4', 'user:u4', 'feature', 'Ship me');
begin
  perform public.feedback_set_status(v_item, 'shipped', '  Live in v0.4  ');
  perform pg_temp.check(
    (select status = 'shipped' and admin_note = 'Live in v0.4' from public.feedback_items where id = v_item),
    'owner can mark an item shipped with a note');
  perform pg_temp.check(
    (select admin_note = 'Live in v0.4' from public.feedback_list(null) where id = v_item),
    'the note is public');
end $$;

select pg_temp.expect_error($$select public.feedback_set_status((select id from public.feedback_items limit 1), 'done')$$, 'invalid_status');
select pg_temp.expect_error($$select public.feedback_set_status(gen_random_uuid(), 'planned')$$, 'not_found');
select pg_temp.expect_error(
  format($$select public.feedback_set_status((select id from public.feedback_items limit 1), 'planned', %L)$$, repeat('x', 281)),
  'invalid_note');

-- ── permissions: the app role reaches only the three client functions ───────
create role feedback_app nologin;
grant usage on schema public to feedback_app;
grant execute on function
  public.feedback_list(text),
  public.feedback_submit(text, text, text, text, text),
  public.feedback_vote(text, uuid, int)
to feedback_app;

-- A second app role for a token-gated board: only the gated vote is granted.
create role gated_app nologin;
grant usage on schema public to gated_app;
grant execute on function
  public.feedback_list(text),
  public.feedback_vote_gated(text, uuid, int, text[])
to gated_app;

create role stranger nologin;
grant usage on schema public to stranger;

set role feedback_app;
select pg_temp.check((select count(*) > 0 from public.feedback_list('x')), 'app role can list');
select pg_temp.check(public.feedback_submit('u5', 'user:u5', 'bug', 'From the app') is not null, 'app role can submit');
select pg_temp.expect_state($$select * from public.feedback_items$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_votes$$, '42501');
select pg_temp.expect_state($$update public.feedback_items set status = 'shipped'$$, '42501');
select pg_temp.expect_state($$insert into public.feedback_votes values (gen_random_uuid(), 'x', 1)$$, '42501');
select pg_temp.expect_state(
  $$select public.feedback_set_status((select id from public.feedback_list(null) limit 1), 'shipped')$$, '42501');
select pg_temp.expect_state(
  $$select * from public.feedback_cast_vote('x', (select id from public.feedback_list(null) limit 1), 1, null, false)$$, '42501');
select pg_temp.check(
  (select my_vote = 1 from public.feedback_vote('app-user', (select id from public.feedback_list(null) limit 1), 1)),
  'app role can vote on an open board');
reset role;

-- On a gated board, a server bug that calls the open vote fails closed.
set role gated_app;
select pg_temp.expect_state(
  $$select * from public.feedback_vote('0xnotaholder', (select id from public.feedback_list(null) limit 1), 1)$$, '42501');
select pg_temp.expect_error(
  $$select * from public.feedback_vote_gated('0xnotaholder', (select id from public.feedback_list(null) limit 1), 1, null)$$,
  'not_eligible');
reset role;

set role stranger;
select pg_temp.expect_state($$select * from public.feedback_list(null)$$, '42501');
select pg_temp.expect_state($$select public.feedback_submit('x','x','bug','Sneaky title')$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_vote('x', gen_random_uuid(), 1)$$, '42501');
select pg_temp.expect_state($$select * from public.feedback_vote_gated('x', gen_random_uuid(), 1, array['b'])$$, '42501');
reset role;

-- Row-level security is on, with no policies, as a second lock.
select pg_temp.check(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.feedback_items'::regclass, 'public.feedback_votes'::regclass)),
  'RLS is enabled on both tables');

\echo 'schema.sql: all checks passed'
