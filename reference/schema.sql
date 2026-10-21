-- Feedback board: reference schema for PostgreSQL 13+ (server-trusted).
--
-- Use this when YOUR SERVER signs the user in and then calls these functions
-- with that user's id. The functions trust the identity arguments they are
-- given (p_viewer, p_author, p_voter), so a browser must never be able to call
-- them directly. Only your server's database role gets EXECUTE.
--
-- Identities are text so any id works: a user id, a lowercased wallet
-- address, a Discord id. Normalize before calling (lowercase wallet addresses).
--
-- On Supabase: this file revokes the anon/authenticated default grants for
-- you, so it is safe to run there. Call it from an Edge Function with the
-- service role, or add reference/supabase.sql for browser calls.
--
-- Status changes go through feedback_set_status(), which no client role can
-- execute. Run it yourself (SQL console, admin script).

-- ── tables ──────────────────────────────────────────────────────────────────
create table if not exists public.feedback_items (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('bug', 'feature')),
  title       text not null check (char_length(title) between 3 and 120),
  body        text check (body is null or char_length(body) <= 2000),
  status      text not null default 'open'
                check (status in ('open', 'planned', 'in_progress', 'shipped', 'declined')),
  admin_note  text check (admin_note is null or char_length(admin_note) <= 280),
  author_id   text,          -- null when anonymous; never returned by feedback_list
  rate_key    text not null, -- user id, or session/IP key for anonymous; rate limiting only
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists feedback_items_rate_idx
  on public.feedback_items (rate_key, created_at desc);

-- One vote per voter per item: the primary key is the guarantee.
-- ballot is only used by token-gated boards: '<chainId>:<contract>:<tokenId>'.
-- The partial unique index lets each token back at most one vote per item.
create table if not exists public.feedback_votes (
  item_id     uuid not null references public.feedback_items (id) on delete cascade,
  voter_id    text not null,
  value       smallint not null check (value in (-1, 1)),
  ballot      text,
  created_at  timestamptz not null default now(),
  primary key (item_id, voter_id)
);

create unique index if not exists feedback_votes_ballot_uq
  on public.feedback_votes (item_id, ballot) where ballot is not null;

-- Defense in depth: no policies means no rows for any client role, even if a
-- grant is added by mistake. The functions below run as the table owner,
-- which RLS does not apply to.
alter table public.feedback_items enable row level security;
alter table public.feedback_votes enable row level security;

-- ── feedback_list: everyone's items, ranked; aggregates only ────────────────
-- Returns the net score and the viewer's own vote (my_vote: -1, 0, 1).
-- Never returns author_id, rate_key, or any voter id.
create or replace function public.feedback_list(p_viewer text default null)
returns table (
  id uuid, kind text, title text, body text, status text, admin_note text,
  created_at timestamptz, score int, upvotes int, downvotes int, my_vote int
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.id, i.kind, i.title, i.body, i.status, i.admin_note, i.created_at,
    coalesce(sum(v.value), 0)::int                                       as score,
    count(v.value) filter (where v.value = 1)::int                       as upvotes,
    count(v.value) filter (where v.value = -1)::int                      as downvotes,
    coalesce(max(v.value) filter (where v.voter_id = p_viewer), 0)::int  as my_vote
  from public.feedback_items i
  left join public.feedback_votes v on v.item_id = i.id
  group by i.id
  order by score desc, i.created_at desc
  limit 200;
$$;

-- ── feedback_submit: the only way to create an item ─────────────────────────
-- Validates, caps lengths, rate-limits per rate key (5 per hour), and always
-- creates the item as 'open'. Error messages are stable codes.
create or replace function public.feedback_submit(
  p_author   text,
  p_rate_key text,
  p_kind     text,
  p_title    text,
  p_body     text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  -- Trim all whitespace, not just spaces, so a title of newlines is empty.
  v_title text := regexp_replace(coalesce(p_title, ''), '^\s+|\s+$', '', 'g');
  v_body  text := nullif(regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g'), '');
begin
  if p_kind is null or p_kind not in ('bug', 'feature') then
    raise exception 'invalid_kind';
  end if;
  if char_length(v_title) < 3 or char_length(v_title) > 120 then
    raise exception 'invalid_title';
  end if;
  if v_body is not null and char_length(v_body) > 2000 then
    raise exception 'invalid_body';
  end if;
  if p_rate_key is null or char_length(p_rate_key) < 1 or char_length(p_rate_key) > 200 then
    raise exception 'invalid_rate_key';
  end if;

  -- Serialize submits per rate key so a burst cannot slip past the count.
  perform pg_advisory_xact_lock(hashtext('feedback_submit:' || p_rate_key));
  if (select count(*) from public.feedback_items
       where rate_key = p_rate_key and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;

  insert into public.feedback_items (kind, title, body, author_id, rate_key, status)
  values (p_kind, v_title, v_body, nullif(p_author, ''), p_rate_key, 'open')
  returning feedback_items.id into v_id;

  return v_id;
end $$;

-- ── voting: one tap, server-side toggle ─────────────────────────────────────
--   no vote  + press up   → up
--   up       + press up   → cleared
--   up       + press down → down
--
-- Two entry points, and the grant decides which kind of board you run:
--   feedback_vote(voter, item, value)                 open boards
--   feedback_vote_gated(voter, item, value, ballots)  token-gated boards
-- Grant exactly one of them to your app role. On a gated board a server bug
-- that calls the open function then fails with "permission denied" instead
-- of quietly letting non-holders vote.
--
-- Ballots ('<chainId>:<contract>:<tokenId>') are tokens your server has
-- VERIFIED this voter holds right now. Each token backs at most one vote per
-- item. Clearing a vote never needs a token, so a wallet that sold its NFT
-- can still take its vote back.

-- The shared implementation. No role may call it directly.
create or replace function public.feedback_cast_vote(
  p_voter   text,
  p_item    uuid,
  p_value   int,
  p_ballots text[],
  p_gated   boolean
)
returns table (score int, my_vote int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_vote   boolean;
  v_old_value  smallint;
  v_old_ballot text;
  v_ballot     text;
begin
  if p_voter is null or p_voter = '' then
    raise exception 'not_signed_in';
  end if;
  if p_value is null or p_value not in (-1, 1) then
    raise exception 'invalid_vote';
  end if;
  if not exists (select 1 from public.feedback_items where id = p_item) then
    raise exception 'not_found';
  end if;

  -- Serialize this voter's taps on this item (double-taps, two tabs).
  perform pg_advisory_xact_lock(hashtext('feedback_vote:' || p_item::text || ':' || p_voter));

  select v.value, v.ballot into v_old_value, v_old_ballot
  from public.feedback_votes v
  where v.item_id = p_item and v.voter_id = p_voter;
  v_has_vote := found;

  if v_has_vote and v_old_value = p_value then
    -- Clearing your own vote never needs a token.
    delete from public.feedback_votes
    where item_id = p_item and voter_id = p_voter;
  else
    if p_gated then
      if p_ballots is null or cardinality(p_ballots) = 0 then
        raise exception 'not_eligible';
      end if;
      if v_has_vote and v_old_ballot = any (p_ballots) then
        v_ballot := v_old_ballot;                  -- still holds the token that backed it
      else
        -- Prefer a token that backs no vote on this item yet.
        select b into v_ballot
        from unnest(p_ballots) with ordinality as t (b, ord)
        where not exists (
          select 1 from public.feedback_votes u
          where u.item_id = p_item and u.ballot = t.b
        )
        order by ord
        limit 1;
        if v_ballot is null then
          -- Every token this voter holds already backs someone else's vote
          -- here. Those votes are stale: the server just verified this voter
          -- holds the tokens now. The current holder's vote replaces one.
          v_ballot := p_ballots[1];
          delete from public.feedback_votes
          where item_id = p_item and ballot = v_ballot and voter_id <> p_voter;
        end if;
      end if;
    end if;

    begin
      if v_has_vote then
        update public.feedback_votes
        set value = p_value, ballot = coalesce(v_ballot, ballot)
        where item_id = p_item and voter_id = p_voter;
      else
        insert into public.feedback_votes (item_id, voter_id, value, ballot)
        values (p_item, p_voter, p_value, v_ballot);
      end if;
    exception when unique_violation then
      -- Another wallet claimed the same token on this item at the same moment.
      raise exception 'ballot_used';
    end;
  end if;

  return query
  select coalesce(sum(v.value), 0)::int,
         coalesce(max(v.value) filter (where v.voter_id = p_voter), 0)::int
  from public.feedback_votes v
  where v.item_id = p_item;
end $$;

create or replace function public.feedback_vote(p_voter text, p_item uuid, p_value int)
returns table (score int, my_vote int)
language sql
security definer
set search_path = ''
as $$
  select * from public.feedback_cast_vote(p_voter, p_item, p_value, null, false);
$$;

create or replace function public.feedback_vote_gated(p_voter text, p_item uuid, p_value int, p_ballots text[])
returns table (score int, my_vote int)
language sql
security definer
set search_path = ''
as $$
  select * from public.feedback_cast_vote(p_voter, p_item, p_value, p_ballots, true);
$$;

-- ── feedback_set_status: owner only ─────────────────────────────────────────
-- No client role can execute this. Example:
--   select public.feedback_set_status('<item id>', 'shipped', 'Live in v0.4');
create or replace function public.feedback_set_status(
  p_item   uuid,
  p_status text,
  p_note   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('open', 'planned', 'in_progress', 'shipped', 'declined') then
    raise exception 'invalid_status';
  end if;
  if p_note is not null and char_length(p_note) > 280 then
    raise exception 'invalid_note';
  end if;
  update public.feedback_items
  set status = p_status, admin_note = nullif(btrim(p_note), ''), updated_at = now()
  where id = p_item;
  if not found then
    raise exception 'not_found';
  end if;
end $$;

-- ── grants ──────────────────────────────────────────────────────────────────
-- Nothing is reachable by default. Tables have no client grants at all; the
-- functions above run as their owner and are the only way in.
revoke all on public.feedback_items, public.feedback_votes from public;
revoke execute on function
  public.feedback_list(text),
  public.feedback_submit(text, text, text, text, text),
  public.feedback_cast_vote(text, uuid, int, text[], boolean),
  public.feedback_vote(text, uuid, int),
  public.feedback_vote_gated(text, uuid, int, text[]),
  public.feedback_set_status(uuid, text, text)
from public;

-- Supabase (and any database with these roles) grants new tables and
-- functions to anon/authenticated by default. Take those grants back.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.feedback_items, public.feedback_votes from %I', r);
      execute format(
        'revoke execute on function public.feedback_list(text), '
        'public.feedback_submit(text, text, text, text, text), '
        'public.feedback_cast_vote(text, uuid, int, text[], boolean), '
        'public.feedback_vote(text, uuid, int), '
        'public.feedback_vote_gated(text, uuid, int, text[]), '
        'public.feedback_set_status(uuid, text, text) from %I', r);
    end if;
  end loop;
end $$;

-- Then let your server's role call the client operations:
--   grant execute on function
--     public.feedback_list(text),
--     public.feedback_submit(text, text, text, text, text)
--   to my_app_role;
-- plus ONE voting function:
--   grant execute on function public.feedback_vote(text, uuid, int) to my_app_role;                -- open board
--   grant execute on function public.feedback_vote_gated(text, uuid, int, text[]) to my_app_role;  -- token-gated
-- Never grant feedback_cast_vote or feedback_set_status to the app role.
