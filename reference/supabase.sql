-- Feedback board: browser-callable layer for Supabase.
--
-- Run reference/schema.sql first. This file adds three functions the browser
-- calls with supabase.rpc(). Each one takes the user from auth.uid(), never
-- from an argument, then calls the server-trusted functions in schema.sql.
--
--   list_feedback()                          anyone
--   submit_feedback(kind, title, body, sess) anyone (anonymous needs a session key)
--   vote_feedback(item, value)               signed-in, non-anonymous users
--
-- Status stays owner-only: run public.feedback_set_status() in the SQL editor.
--
-- Token-gated voting needs an on-chain check the database cannot make. For a
-- gated board, do NOT grant vote_feedback (delete the grant line at the end);
-- vote through an Edge Function that checks holdings and calls
-- public.feedback_vote_gated() with the service role (FEEDBACK-BOARD.md, 10.5).

create or replace function public.list_feedback()
returns table (
  id uuid, kind text, title text, body text, status text, admin_note text,
  created_at timestamptz, score int, upvotes int, downvotes int, my_vote int
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.feedback_list((select auth.uid())::text);
$$;

-- Anonymous visitors pass a random per-browser session key (16-64 chars of
-- [A-Za-z0-9_-]) that only feeds the rate limit. It bounds accidental bursts,
-- not a determined spammer, and the same is true of Supabase anonymous
-- sign-ins (each one is a fresh user id). If spam shows up, require a real
-- sign-in (see below) or move submit behind an Edge Function with a CAPTCHA.
create or replace function public.submit_feedback(
  p_kind    text,
  p_title   text,
  p_body    text default null,
  p_session text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid text := (select auth.uid())::text;
begin
  if v_uid is null then
    -- To require sign-in for submitting, replace this block with:
    --   raise exception 'not_signed_in';
    if p_session is null or p_session !~ '^[A-Za-z0-9_-]{16,64}$' then
      raise exception 'invalid_session';
    end if;
    return public.feedback_submit(null, 'anon:' || p_session, p_kind, p_title, p_body);
  end if;
  return public.feedback_submit(v_uid, 'user:' || v_uid, p_kind, p_title, p_body);
end $$;

-- Supabase anonymous sign-ins create real "authenticated" sessions that cost
-- nothing to mint, so they would let one person vote many times. They count
-- as signed out here.
create or replace function public.vote_feedback(p_item uuid, p_value int)
returns table (score int, my_vote int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  text    := (select auth.uid())::text;
  v_anon boolean := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
begin
  if v_uid is null or v_anon then
    raise exception 'not_signed_in';
  end if;
  return query select * from public.feedback_vote(v_uid, p_item, p_value);
end $$;

revoke execute on function
  public.list_feedback(),
  public.submit_feedback(text, text, text, text),
  public.vote_feedback(uuid, int)
from public, anon, authenticated;

grant execute on function public.list_feedback() to anon, authenticated;
grant execute on function public.submit_feedback(text, text, text, text) to anon, authenticated;
grant execute on function public.vote_feedback(uuid, int) to authenticated;
