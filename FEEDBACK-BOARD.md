# Community Feedback Board: build spec

A spec you can hand to any coding agent. It describes a small feedback board for a website or app. A floating button opens a panel where people see everyone's feedback, vote it up or down, post a bug or an idea, and see its status change to **Shipped**. Section 10 covers token gating for NFT communities.

**How to use it:** give your agent this file and say *"Read FEEDBACK-BOARD.md and build this into my project."* The file is self-contained. The `reference/` folder in the same repository has tested example code (Postgres, Supabase, a framework-free widget, a wallet token gate). It helps but is not required.

---

## 0. For the agent: read this first

1. **Inspect the project before building.** Find its framework, auth, database, hosting, and design tokens (colors, font, radius). Reuse all of them. Never add a second sign-in system.
2. **Settle the five decisions in section 3.** Answer from the codebase where you can, ask the owner only what you can't find out, and otherwise use the defaults listed.
3. **Keep every rule in section 2**, whatever the stack. Those rules are the product.
4. **Enforce on the server.** The widget only displays. Validation, one vote per person, rate limits, eligibility, and status changes are enforced where a client cannot reach.
5. **Finish with the checks in section 11** and report which pass.
6. **Keep it small** (section 12). If the owner asks for comment threads, assignees, or labels, explain that those belong in a ticketing tool and suggest one, rather than growing this.

---

## 1. What it is

- **One button, one panel.** People see *everyone's* feedback, not only their own.
- **Community voting.** Anyone allowed to vote can upvote or downvote. Items sort by net score, so the top of the list is what the community wants most.
- **Visible status.** The owner moves items through Open, Planned, In progress, Shipped, or Declined, with an optional one-line note. When an item ships, everyone who wanted it sees it.

Why this works better than a private feedback form:

- **Votes show what matters to many people.** A single report can send you chasing one person's confusion. Votes show whether others hit it too.
- **People see their post land and can follow it.** Seeing *Shipped* on something they asked for keeps early users engaged.
- **Nobody has to triage the long tail.** Downvoted and stale items sink on their own.

---

## 2. Rules every version keeps

1. **Shared view.** Everyone allowed to view sees every item. Never filter to "my feedback."
2. **One vote per person per item.** A vote is +1 or -1. A unique constraint in storage enforces it, not only the UI.
3. **The server decides the toggle.** Pressing the same arrow again clears the vote. Pressing the other arrow switches it.

   | Current vote | Pressed | Result |
   |---|---|---|
   | none | up | up |
   | up | up | none |
   | up | down | down |
   | down | down | none |
   | down | up | up |

4. **Ranking.** Net score, highest first, then newest first.
5. **Only the owner sets status and the note.** New items are always created as `open`. No client can set status, on create or later.
6. **Identities stay private.** The list returns totals and the viewer's own vote. It never returns voter ids, author ids, wallet addresses, emails, or IPs.
7. **The server validates input.** `kind` is `bug` or `feature`. Title is 3 to 120 characters after trimming. Body is optional, up to 2,000 characters. Owner note is up to 280.
8. **Posting is rate limited.** Default: 5 posts per rolling hour per person, or per anonymous session.
9. **User text is shown as text.** Use `textContent` or the framework's escaping. Never insert it as HTML, and don't render Markdown unless it goes through a sanitizer.
10. **Fixed statuses:** `open`, `planned`, `in_progress`, `shipped`, `declined`.

---

## 3. Decisions to make before building

| # | Decision | Default | Other options |
|---|---|---|---|
| 1 | Who can view, post, vote | Anyone views and posts; signed-in users vote | Members only for everything; token-gated (section 10) |
| 2 | Identity | The app's existing sign-in | Email link, OAuth, wallet (SIWE), Discord |
| 3 | Where data lives | The app's existing database | No backend: Supabase (`reference/supabase.sql`), or a serverless function plus a database |
| 4 | How the owner sets status | SQL console or a local admin script | A page behind real admin auth. Never a client-side check |
| 5 | Placement | Floating button, bottom right, every page | A `/feedback` page, or a nav button that opens the panel |

**Voting needs a real identity.** If the site has no accounts, add the lightest sign-in that fits (email link, OAuth, or wallet), or launch with view and post only and add voting later. Don't use cookies, localStorage, or fingerprints as a voter id: clearing them means voting again.

---

## 4. Data model

Two tables.

**`feedback_items`**

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `kind` | text | `bug` or `feature` (shown as "Idea") |
| `title` | text | 3-120 chars |
| `body` | text, nullable | up to 2,000 chars |
| `status` | text | `open` by default; owner-only after that |
| `admin_note` | text, nullable | owner's public one-liner, up to 280 chars |
| `author_id` | text, nullable | null when anonymous; never returned to clients |
| `rate_key` | text | user id, or anonymous session key; for rate limiting only |
| `created_at`, `updated_at` | timestamp | |

**`feedback_votes`**

| Field | Type | Notes |
|---|---|---|
| `item_id` | uuid | references the item; delete votes with the item |
| `voter_id` | text | user id or lowercased wallet address |
| `value` | smallint | +1 or -1 |
| `ballot` | text, nullable | token-gated boards only (section 10.4) |
| `created_at` | timestamp | |
| **primary key** | `(item_id, voter_id)` | the one-vote rule |
| **unique** | `(item_id, ballot)` where `ballot` is not null | one vote per token per item |

Ids are text so any identity fits: a user id, a lowercased wallet address, a Discord id. Lowercase wallet addresses before you store or compare them.

The Postgres version, with validation in check constraints, is in `reference/schema.sql`. For other storage:

- **MySQL, SQLite (including Cloudflare D1):** same tables and keys. Do the vote toggle and the rate-limit count inside one transaction in your server code.
- **Firestore and other document stores:** `items/{itemId}` plus `items/{itemId}/votes/{voterId}`. The vote document id is the one-vote rule. Keep `score` on the item and update it from a server trigger (a Cloud Function). Security rules must block clients from writing `score`, `status`, and `admin_note`, and must only let a user write the vote document whose id is their own uid.
- **Redis:** a hash per item, `votes:{itemId}`, field = voter id, value = ±1. Do the toggle and score update in one Lua script or `MULTI` transaction.

---

## 5. Operations

Four operations: three for clients, one for the owner.

| Operation | Input | Returns | Who |
|---|---|---|---|
| **list** | viewer (may be none) | items, ranked | anyone allowed to view |
| **submit** | `kind`, `title`, `body?` | new item id | anyone allowed to post |
| **vote** | item id, `value` (+1 or -1) | `score`, `myVote` | signed-in, eligible voters |
| **set status** | item id, `status`, `note?` | nothing | owner only |

An item as clients see it:

```json
{
  "id": "6f1c…",
  "kind": "bug",
  "title": "Login link expires before the email arrives",
  "body": "It says expired when I open it about 10 minutes later.",
  "status": "in_progress",
  "adminNote": "Links now last 30 minutes. Rolling out this week.",
  "score": 18,
  "upvotes": 19,
  "downvotes": 1,
  "myVote": 1,
  "createdAt": "2026-10-21T17:04:00Z"
}
```

`myVote` is -1, 0, or 1 for the current viewer, and 0 when signed out. The list returns at most 200 items. Add pagination only if a board actually gets that big.

**Error codes.** Return stable codes so the widget can show the right message:

| Code | When | HTTP |
|---|---|---|
| `not_signed_in` | voting (or posting, if posting needs sign-in) without a session | 401 |
| `not_eligible` | signed in but not allowed (e.g. not a holder) | 403 |
| `ballot_used` | two wallets claimed the same token on the same item at the same moment (rare; retry) | 409 |
| `rate_limited` | over the posting limit | 429 |
| `invalid_kind`, `invalid_title`, `invalid_body`, `invalid_vote`, `invalid_status` | validation failed | 400 |
| `not_found` | no such item | 404 |

**REST mapping**, if the project uses REST:

```
GET  /api/feedback               → 200 [item, …]
POST /api/feedback               → 201 { "id": "…" }        body: { kind, title, body?, session? }
POST /api/feedback/:id/vote      → 200 { "score": 4, "myVote": 1 }   body: { value: 1 | -1 }
                                   errors → { "error": "<code>" }
```

Don't expose set-status over the public API. If the owner needs a web page for it, put it behind real admin authorization on the server.

**Rate limit votes too**, on the server: about 30 a minute per voter is plenty for people and stops scripts. On gated boards every vote costs RPC calls, so this matters more there.

**Requests that change data** (post, vote) must be JSON. Reject any other content type, so a plain HTML form on another site can't submit to your API with the user's cookies.

**The vote, step by step** (in one transaction):

```
lock (item, voter)                    -- a double tap or two tabs must not create two rows
existing ← vote row for (item, voter)
if existing.value = pressed: delete it                      -- clear
else if existing: update value                               -- switch
else: insert (item, voter, pressed)                          -- new
return the item's new score and the voter's vote
```

The unique key is the backstop if the lock is missing. `reference/schema.sql` implements this as `feedback_vote()` for open boards and `feedback_vote_gated()` for token-gated boards (section 10.4).

**Rate limiting posts.** Use the user id as the key when signed in. Otherwise use an anonymous session key: a random value the widget keeps in localStorage. On your own server, add the IP to it. Count posts for that key in the last hour inside the same transaction as the insert, with a lock, so a burst can't slip past the count. An anonymous session key slows down accidental floods, not a determined spammer. If spam shows up, require sign-in to post or add a CAPTCHA check on the server.

**Server-trusted functions.** The functions in `reference/schema.sql` take the user's id as an argument and trust it. Only your server may call them. Never expose them to a browser. `reference/supabase.sql` adds browser-safe wrappers that read the user from the Supabase session instead.

**Grant exactly one voting function** to your app's database role: `feedback_vote` on an open board, `feedback_vote_gated` on a token-gated one. Then a server bug that calls the wrong one fails with "permission denied" instead of quietly letting everyone vote.

---

## 6. The widget

**Layout**

- **Trigger:** a floating button, bottom right, above other content, clear of the safe-area insets on phones. Icon plus "Feedback". On very narrow screens the label hides and an `aria-label` keeps the name.
- **Panel:** a modal dialog anchored bottom right on desktop. At 640px wide or less it becomes a bottom sheet about 88% of the screen height.
  - Header: title ("Community feedback"), one line of help, Close.
  - Toolbar: filters **All / Bugs / Ideas / Shipped**, and a **New** button.
  - List: one row per item.
  - Form, shown in place of the list when posting: type (Bug / Idea), title, details (optional), Cancel, Send.

**Each row**

- A vote column: up arrow, net score in tabular numbers, down arrow. The pressed arrow is highlighted.
- A type chip (Bug / Idea) and a status chip. Status chips use color *and* a text label: neutral for Open, accent for Planned, amber for In progress, green for Shipped, muted for Declined.
- The title, then the body clamped to three lines with a "Show more" toggle.
- The owner's note, if any, under the body with a left border in the status color.

**Behavior**

- **Votes update immediately**, then reconcile with the server's answer. On failure, roll back and say so.
- **Rows don't move while the panel is open.** A vote changes the score in place; the new ranking appears on the next load. Rows that jump away from the pointer cause misclicks.
- **Keyboard focus stays on the arrow** that was pressed.
- **After posting**, return to the list, highlight the new item, and confirm with a short message ("Thanks. It's on the board.").
- **When sign-in is needed** (a signed-out vote), show an inline notice with a sign-in link, or hand off to the app's own sign-in (a wallet modal, for example). The score doesn't change.
- **When the user isn't eligible**, show the gate note ("Voting is for holders.").
- **States to cover:** loading, empty ("No feedback yet. Add the first."), load error with Retry, rate limited, sent.
- **Load the list only when the panel opens.** Load the widget's code lazily (on idle or first click) so it adds nothing to page load.

**Accessibility**

- A real modal dialog with an accessible name. Escape closes it. On close, focus returns to the element that opened it, or to the trigger.
- Vote arrows are `<button>`s with `aria-pressed` and labels that include the item title ("Upvote: Dark mode").
- Filter buttons use `aria-pressed`. Form errors use `role="alert"`; confirmations use `role="status"`.
- Text contrast meets WCAG AA in light and dark themes. Status is never shown by color alone.
- Respect `prefers-reduced-motion`. Animate only `transform` and `opacity`.
- Touch targets are at least 44px. Inputs use a 16px font so iOS doesn't zoom.

**Look.** Use the host app's design tokens and font. The widget should look like part of the product, not an embed. Support light and dark.

**Reference implementation.** `reference/feedback-board.js` is a framework-free custom element that follows all of the above:

```html
<feedback-board sign-in-url="/login" gate-note="Voting is for holders."></feedback-board>
<script type="module">
  import { defineFeedbackBoard, httpAdapter } from './feedback-board.js';
  defineFeedbackBoard();
  document.querySelector('feedback-board').adapter = httpAdapter({ baseUrl: '/api/feedback' });
</script>
```

It talks to the backend only through an adapter with three methods: `list()`, `submit({ kind, title, body, session })`, `vote(id, value)`. Errors are `FeedbackError(code)` with the codes from section 5. It fires cancelable `feedback-sign-in` and `feedback-not-eligible` events, so the host app can open its own sign-in instead of the built-in notice. In React, Vue, or Svelte, either use the element as is or port it into a native component, keeping the same behavior.

---

## 7. Running the board

- **Once a week**, sort by score. The top few items are your queue.
- **Move items forward:** `planned`, then `in_progress`, then `shipped` with a one-line note ("Shipped in 1.4").
- **Decline with a reason** instead of leaving items open forever ("Not planned: we'd rather not add more email.").
- **Duplicates:** decline the newer one with the note "Same as: <title>". Don't build merging.
- **Spam or abuse:** delete the item. Its votes go with it.
- **Size:** the reference list query totals every vote on each call. That is instant for hundreds of items and thousands of votes. If a board grows past a few thousand items, keep a `score` column updated by the vote function, index it, and paginate.

With `reference/schema.sql`:

```sql
select id, title, score, status from public.feedback_list(null);
select public.feedback_set_status('<item id>', 'shipped', 'Shipped in 1.4');
delete from public.feedback_items where id = '<spam item id>';
```

---

## 8. Security checklist

- [ ] No client role can change `status` or `admin_note`. Tested by attempting it as a normal user.
- [ ] Clients can't read the raw tables or any voter, author, or wallet field.
- [ ] Validation and rate limits run on the server.
- [ ] User text is rendered as text everywhere: widget, admin views, emails, notifications.
- [ ] Sessions are a random session id (or a signed cookie) mapped to the user on the server. Never a cookie holding a bare user id or wallet address; anyone can forge that.
- [ ] Cookie-based sessions: `SameSite=Lax` (or stricter) cookies, plus an `Origin` check or CSRF token on POST. POSTs that aren't `application/json` are rejected. No credentialed CORS for other origins.
- [ ] Votes are rate limited on the server, as well as posts.
- [ ] **Supabase:** new tables and functions are granted to `anon` and `authenticated` by default. Revoke those grants explicitly and let functions be the only way in. (In this repo's tests, leaving the revokes out let a signed-out visitor read the raw items table.) Keep the service-role key on the server.
- [ ] **Supabase anonymous sign-ins** create real sessions that cost nothing to make. Treat them as signed out for voting.
- [ ] Secrets (service-role key, RPC provider key, admin credentials) never reach the browser bundle.
- [ ] Eligibility checks fail closed. If the check errors, the vote is rejected.

---

## 9. Platform recipes

**Next.js, Remix, SvelteKit, Nuxt, Rails, Django, Laravel (anything with a server).** Add the two tables to your database. Implement the four operations as route handlers or server actions, taking the user from your existing session. With Postgres, install `reference/schema.sql`, grant `feedback_list`, `feedback_submit`, and one voting function to your app's database role (section 5), and call them. Use the reference widget, or port it into a component.

**Supabase, no server of your own.** Run `reference/schema.sql`, then `reference/supabase.sql`. The browser calls `list_feedback`, `submit_feedback`, and `vote_feedback` with `supabase.rpc()`. Users come from Supabase Auth. Set status in the SQL editor with `feedback_set_status`.

**Static sites and no-code builders (Webflow, Framer, Squarespace, Wix, plain HTML).** Paste the widget's `<script type="module">` into the site's custom-code area. Point its adapter at a small backend: Supabase as above, or serverless functions (Vercel, Netlify, Cloudflare Workers) plus a database. You need *some* server-side state for voting to work.

**Firebase.** Firestore collections as in section 4. Anonymous Firebase Auth users can post but shouldn't vote, for the same reason as Supabase anonymous sign-ins. A Cloud Function keeps each item's `score` updated.

**WordPress.** A small plugin. Create the two tables on activation with `dbDelta`. Register REST routes with `register_rest_route` and a `permission_callback`. Send `X-WP-Nonce` (from `wp_create_nonce('wp_rest')`) from the widget. Add an admin screen gated by `current_user_can('manage_options')` for setting status.

**Shopify.** An app with an app proxy. Storefront requests reach your backend with `logged_in_customer_id`, signed with a `signature` parameter. Verify that signature before trusting the customer id. Embed the widget with a theme app extension.

**Discord (no website).** A bot instead of a widget. A `/feedback` command opens a modal to post. Each item is a message with ▲ and ▼ buttons, and the bot stores one vote per Discord user id. A pinned message lists the top items. Status changes are an owner-only slash command. A forum channel with tags covers some of this with no code, but reactions allow both up and down at once, and members can change tags.

**Mobile apps (iOS, Android, React Native).** A native sheet with the same layout. Call the same API with the app's auth token.

---

## 10. Token gating for NFT communities

Gating means: only wallets that hold a token from your collection can do certain things on the board. Everything in sections 1–9 still applies. Gating adds wallet identity, holder checks, and protection against one NFT voting many times.

### 10.1 Choose what to gate

| Setup | View | Post | Vote | Good for |
|---|---|---|---|---|
| **Holders vote** (recommended) | anyone | anyone | holders | Public projects: anyone can report a bug, holders set priorities |
| **Holders post and vote** | anyone | holders | holders | A public roadmap driven only by holders |
| **Holders only** | holders | holders | holders | A private holder space |

If viewing is gated, gate it on the server. The list endpoint must not return items to non-holders. Hiding them in the UI is not enough.

### 10.2 Wallet sign-in (Sign-In with Ethereum, EIP-4361)

A wallet proves who it is by signing a short, standard message. The flow:

1. The browser asks your server for a **nonce**. The server stores it, single-use, for about 5 minutes.
2. The browser builds the EIP-4361 message (your domain, the wallet address, chain id, the nonce, an issued-at time) and asks the wallet to sign it.
3. The browser sends the message and signature to your server.
4. The server checks, in order:
   - the message **domain** is your site's domain;
   - the **chain id** is the one you expect;
   - the message hasn't **expired**;
   - the **nonce** exists, hasn't expired, and is deleted on this use;
   - the **signature** is valid for the address. Use a library that supports smart-contract wallets (ERC-1271, ERC-6492), such as viem's `verifySiweMessage`.
5. The server starts a session for the lowercased address: a random session id stored server-side, or a signed session cookie (httpOnly, Secure, SameSite). **Never a cookie that holds the bare address**: anyone could set it to a holder's address. From then on the address comes from the session, never from a request body.
6. Rate-limit the nonce route. It's public, and every call stores a nonce.

> **Trap:** viem's `verifySiweMessage` only checks the domain and nonce if you pass them in. Leave them out and it accepts a message signed for another site. Always pass `domain` and `nonce`, and check the chain id yourself.

Options by stack:

- **Any Node server:** `reference/token-gate.mjs` (`issueNonce`, `verifySignIn`). It uses viem.
- **Supabase:** Supabase Auth supports wallet sign-in (`signInWithWeb3`, Ethereum and Solana). The wallet becomes a normal Supabase user. Holder checks still need a server step (10.5).
- **Solana:** Sign In With Solana (SIWS), the same pattern through the wallet standard's `signIn`.
- **No wallet on the site:** let a Discord bot that verifies holders (Collab.Land, Guild.xyz, or your own) give holders a role. Then use "Sign in with Discord" with the `guilds.members.read` scope and check the role through `GET /users/@me/guilds/{guild.id}/member`.

### 10.3 Checking holdings

Always on the server, against the chain, never from anything the browser claims.

| Standard | Holder if | Notes |
|---|---|---|
| ERC-721 | `balanceOf(wallet) ≥ 1` | Most NFT collections |
| ERC-1155 | `balanceOf(wallet, tokenId) ≥ 1` | Gate on a specific token id |
| ERC-20 | `balanceOf(wallet) ≥ minimum` | Set the minimum in base units (decimals) |
| Solana NFT | the wallet owns an asset in your **verified** collection | Via a DAS-capable RPC (`searchAssets` with `ownerAddress` and `grouping: ["collection", <collection address>]`). Anyone can mint a token that claims an unverified collection. |

Rules:

- **Identify the collection by contract address and chain id.** Never by name, symbol, or image; anyone can copy those.
- **Several collections:** holding any one of them qualifies, unless the owner says otherwise.
- **ERC-1155 and ERC-20 balances can be split.** Someone holding 10 units can move 1 into each of 10 wallets and vote 10 times. Set the minimum high enough that splitting costs something, use a snapshot (10.4 B), or weight votes by balance.
- **Fail closed.** If the RPC call fails, the user is not a holder for that request.
- **Caching:** caching "is a holder" for up to 5 minutes is fine for *viewing*. Check again at vote time, or use ballots (10.4).
- **Cold wallets:** holders often keep NFTs in a vault and sign with a hot wallet. Support the delegate.xyz registry: the hot wallet signs in, names the vault, and the server checks the delegation on-chain (`checkDelegateForContract` in v2). Then check holdings for the vault and use the **vault address** as the voter id, so one vault can't vote through several hot wallets.
- **RPC keys** stay on the server.

### 10.4 Votes that can't be farmed

A plain "holds a token right now" check has a hole. A holder votes, sends the NFT to a second wallet, and that wallet votes too. One NFT, many votes. Pick a fix:

**A. Token ballots (recommended for ERC-721).** Each vote records the token that backs it, as a ballot string `"<chainId>:<contract>:<tokenId>"`. Each token backs at most one vote per item (a unique `(item_id, ballot)` index), and each wallet still has one vote per item.

- At vote time the server lists the tokens the wallet holds now and passes them as ballots to `feedback_vote_gated`. The database uses the first one that backs no vote on that item yet.
- **When a token changes hands, the new holder's vote replaces the old one.** If every token the voter holds already backs someone else's vote on that item, those votes are stale: the server just verified this voter holds the tokens now. The database removes one stale vote and gives its token to the new holder. Passing an NFT between wallets never adds a vote.
- If the voter still holds the token behind their vote, switching keeps it. If they sold it, switching moves the vote to a token they hold now.
- **Clearing a vote never needs a token,** so someone who sold their NFT can still take their vote back. Casting or switching does need one.
- A whale with 10 NFTs in one wallet has one vote per item. Spreading them across 10 wallets gets 10 votes, which equals holding 10 tokens, the most that's possible anyway.
- **Getting the wallet's token ids:** call `tokenOfOwnerByIndex` if the contract is ERC-721 Enumerable, or use an indexer API. You can also let the browser suggest ids. Either way, verify every id with `ownerOf` on the server. `reference/token-gate.mjs` (`ballotsFor`) does this, and refuses non-ERC-721 gates.
- A vote from a wallet that sold its token keeps counting until the token is used on that item again. That's one vote per token either way.

**B. Snapshot list.** Record eligible wallets as of a block, and refresh on a schedule (daily, or before a vote push). Store the list in a table and check it at vote time. This works for ERC-1155, ERC-20, several chains, and with no RPC call per vote. Transfers between snapshots can't create extra votes. New buyers wait for the next snapshot.

**C. Live check only.** Fine for low-stakes boards. Write down that you accepted the transfer hole.

**Weighting.** Default to one vote per wallet per item, unweighted. A feedback board should show how widely something is wanted, not how much capital is behind it. If the owner wants token-weighted votes, store the weight on the vote row at vote time and label totals as "votes", not "people".

### 10.5 The gated vote on the server

```js
import { createTokenGate, memoryNonceStore } from './token-gate.mjs';
import { mainnet } from 'viem/chains';

const gate = createTokenGate({
  rpcUrl: process.env.RPC_URL,
  chain: mainnet,
  domain: 'example.com',
  gates: [{ address: '0xYourCollection', standard: 'erc721' }],
  nonces: memoryNonceStore(),          // use your database or Redis with more than one server
});

// GET /auth/nonce   (rate-limit this route)
return json({ nonce: await gate.issueNonce() });

// POST /auth/verify   body: { message, signature }
const { address } = await gate.verifySignIn(body);   // throws GateError with a code
await session.start({ address });                    // random session id, httpOnly cookie

// POST /api/feedback/:id/vote   body: { value }
const { address } = await session.current();
if (!address) return error(401, 'not_signed_in');
const ballots = await gate.ballotsFor(address);      // [] when not a holder
const [result] = await sql`
  select * from public.feedback_vote_gated(${address}, ${id}, ${value}, ${ballots})`;
return json({ score: result.score, myVote: result.my_vote });
```

`feedback_vote_gated` raises `not_eligible` when there are no ballots (unless the voter is clearing their vote) and, rarely, `ballot_used` on a race. Map them to 403 and 409. A `GateError` of `gate_unavailable` means the RPC failed: return 503 and reject the vote.

On **Supabase**: users sign in with `signInWithWeb3`. Don't grant `vote_feedback` (the browser wrapper). Instead add an Edge Function that reads the user's wallet from their session, gets ballots, and calls `public.feedback_vote_gated` with the service role.

For ERC-1155 or ERC-20 gates (no ballots), check `gate.isHolder(address)` or your snapshot table on the server first, then call `feedback_vote`. Read the splitting note in 10.3.

### 10.6 What the widget shows

- Sign-in for voting is "Connect wallet". Listen for the widget's `feedback-sign-in` event, call `preventDefault()`, and open your wallet flow.
- Set the gate note to say exactly who can vote: "Voting is for holders of <Collection>."
- On `ballot_used` (a rare race): "That token was just used on this item. Try again."
- Never show wallet addresses, ENS names, or token ids next to items or votes.

### 10.7 Extra checks for gated boards

- [ ] A wallet with no token gets `not_eligible`, and the score doesn't change.
- [ ] A holder can vote. After the token moves to a second wallet and that wallet votes on the same item, the first wallet's vote no longer counts. The score never goes up from passing a token around.
- [ ] A wallet that sold its token can clear its vote, but can't cast a new one.
- [ ] On a gated board the app's database role can't call the open `feedback_vote`.
- [ ] A reused nonce, a message for another domain, a wrong chain id, an expired message, and a signature from a different wallet are all rejected.
- [ ] A browser-supplied address or token id is never trusted without an on-chain check.
- [ ] With the RPC unreachable, votes are rejected, not accepted.

---

## 11. Acceptance checks

Run these before calling it done. Automate the ones your stack makes easy.

**Data and server**

1. Posting trims input and creates an `open` item. A bad kind, a title under 3 or over 120 characters, and a body over 2,000 are rejected with their codes.
2. The sixth post in an hour from one key is `rate_limited`. Another key is not.
3. Vote toggle: up, up again (cleared), down, up. Score and `myVote` are right after each step. There is one vote row per voter per item.
4. Two quick taps in two tabs never create two rows.
5. The list is ordered by score, then newest. `myVote` is the viewer's own. No identity field appears in the response.
6. As a normal user, trying to change status, read raw tables, or call owner-only operations is refused.
7. The owner can set each status with a note, and clients see it.

**Widget**

8. Opening, voting, posting, filtering, and closing all work with a keyboard. Escape closes, and focus returns to the opener.
9. A signed-out vote shows the sign-in prompt and doesn't change the score. A failed vote rolls back with a message.
10. Text like `<img src=x onerror=alert(1)>` in a title, body, or note shows as literal text.
11. No horizontal scrolling at 320, 375, 768, 1024, 1440, and 1920px, in light and dark.
12. An automated accessibility scan (axe) of the open panel and the form reports no violations, in light and dark.
13. Works in current Chrome, Firefox, and Safari, including iOS Safari.

**Token-gated boards:** also everything in 10.7.

---

## 12. Keep it small

Not included, on purpose:

- comment threads or replies
- assignees, due dates, priorities, SLAs
- labels beyond Bug and Idea
- merging duplicates
- email notifications (optional later: one email to the author when their item ships)
- per-user "my feedback" pages

If a project needs those, it has outgrown this board. Move to a real tool (Linear, GitHub Issues, Canny) rather than growing this one. The board stays useful because it takes one tap to use.
