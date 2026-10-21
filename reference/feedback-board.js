// <feedback-board>: a framework-free community feedback widget.
//
//   <feedback-board sign-in-url="/login"></feedback-board>
//   <script type="module">
//     import { defineFeedbackBoard, httpAdapter } from './feedback-board.js';
//     defineFeedbackBoard();
//     document.querySelector('feedback-board').adapter = httpAdapter({ baseUrl: '/api/feedback' });
//   </script>
//
// The adapter is the only part that talks to your backend:
//   list()                         → Promise<Item[]>
//   submit({ kind, title, body, session }) → Promise<{ id }>   session: per-browser rate-limit key
//   vote(id, value)                → Promise<{ score, myVote }>   value 1 | -1; the server toggles
// Item: { id, kind, title, body, status, adminNote, score, myVote, createdAt }
// Throw FeedbackError(code) for not_signed_in, not_eligible, ballot_used,
// rate_limited, invalid_title, invalid_body. Anything else shows a generic error.
//
// Attributes: heading, label, sign-in-url, gate-note, theme ("light" | "dark").
// Events (bubble, composed, cancelable): feedback-sign-in, feedback-not-eligible.
// Cancel one to run your own flow (a wallet modal, say) instead of the notice.

export class FeedbackError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'FeedbackError';
    this.code = code;
  }
}

const HTTP_CODES = { 401: 'not_signed_in', 403: 'not_eligible', 429: 'rate_limited' };

// headers: an object, or a (sync or async) function returning one, e.g. to
// send a per-session CSRF token. Keep credentials 'same-origin' unless the API
// lives on another origin; then use 'include' only with an exact-origin CORS
// allowlist and a CSRF check on the server.
export function httpAdapter({ baseUrl, headers = {}, credentials = 'same-origin', fetch: doFetch = globalThis.fetch }) {
  const call = async (path, init = {}) => {
    const extra = typeof headers === 'function' ? await headers() : headers;
    const res = await doFetch(`${baseUrl}${path}`, {
      credentials,
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...extra },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new FeedbackError(data?.error ?? HTTP_CODES[res.status] ?? 'error');
    return data;
  };
  return {
    list: async () => {
      const data = await call('');
      return (Array.isArray(data) ? data : data?.items ?? []).map(fromWire);
    },
    submit: (input) => call('', { method: 'POST', body: JSON.stringify(input) }),
    vote: async (id, value) => {
      const data = await call(`/${encodeURIComponent(id)}/vote`, { method: 'POST', body: JSON.stringify({ value }) });
      return { score: data.score, myVote: data.myVote ?? data.my_vote ?? 0 };
    },
  };
}

// Accepts snake_case rows straight from the SQL functions.
function fromWire(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body ?? null,
    status: row.status,
    adminNote: row.adminNote ?? row.admin_note ?? null,
    score: Number(row.score ?? 0),
    myVote: Number(row.myVote ?? row.my_vote ?? 0),
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

const STATUS_LABEL = { open: 'Open', planned: 'Planned', in_progress: 'In progress', shipped: 'Shipped', declined: 'Declined' };
const KIND_LABEL = { bug: 'Bug', feature: 'Idea' };
const FILTERS = [['all', 'All'], ['bug', 'Bugs'], ['feature', 'Ideas'], ['shipped', 'Shipped']];
const MESSAGES = {
  load: 'Couldn’t load feedback.',
  vote: 'Couldn’t save your vote. Try again.',
  submit: 'Couldn’t send that. Try again.',
  rate_limited: 'You’ve sent a lot in the last hour. Try again later.',
  invalid_title: 'The title needs 3 to 120 characters.',
  invalid_body: 'Details can be up to 2,000 characters.',
  ballot_used: 'That token was just used on this item. Try again.',
  sent: 'Thanks. It’s on the board.',
};

const ICON = {
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

const STYLE = `
:host {
  --fb-surface: #ffffff; --fb-raised: #f5f5f3; --fb-text: #16171a; --fb-muted: #5d5f66;
  --fb-border: #e3e3df; --fb-accent: #3451f5; --fb-accent-ink: #ffffff; --fb-accent-tint: #e9edff;
  --fb-down: #b42318; --fb-down-tint: #fdecea;
  --fb-open-bg: #efefec; --fb-open: #4a4c52; --fb-planned-bg: #e9edff; --fb-planned: #2c3fc4;
  --fb-progress-bg: #fdf1d8; --fb-progress: #8a4b05; --fb-shipped-bg: #dcf5e4; --fb-shipped: #146c34;
  --fb-declined-bg: #f1f1ef; --fb-declined: #75777e;
  --fb-radius: 16px; --fb-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --fb-shadow: 0 24px 64px -16px rgb(16 17 20 / 0.28), 0 2px 6px rgb(16 17 20 / 0.08);
  font-family: var(--fb-font, inherit);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --fb-surface: #141518; --fb-raised: #1d1e22; --fb-text: #ececee; --fb-muted: #a2a4ac;
    --fb-border: #2c2d33; --fb-accent: #8095ff; --fb-accent-ink: #0d0f1a; --fb-accent-tint: #1f2650;
    --fb-down: #ff8a80; --fb-down-tint: #3a1b1a;
    --fb-open-bg: #26272c; --fb-open: #c9cad0; --fb-planned-bg: #1f2650; --fb-planned: #b4c0ff;
    --fb-progress-bg: #3a2a0c; --fb-progress: #f7c25c; --fb-shipped-bg: #12301f; --fb-shipped: #6ee7a0;
    --fb-declined-bg: #1f2024; --fb-declined: #8b8d95;
    --fb-shadow: 0 24px 64px -16px rgb(0 0 0 / 0.6), 0 0 0 1px #2c2d33;
    color-scheme: dark;
  }
}
:host([theme="dark"]) {
  --fb-surface: #141518; --fb-raised: #1d1e22; --fb-text: #ececee; --fb-muted: #a2a4ac;
  --fb-border: #2c2d33; --fb-accent: #8095ff; --fb-accent-ink: #0d0f1a; --fb-accent-tint: #1f2650;
  --fb-down: #ff8a80; --fb-down-tint: #3a1b1a;
  --fb-open-bg: #26272c; --fb-open: #c9cad0; --fb-planned-bg: #1f2650; --fb-planned: #b4c0ff;
  --fb-progress-bg: #3a2a0c; --fb-progress: #f7c25c; --fb-shipped-bg: #12301f; --fb-shipped: #6ee7a0;
  --fb-declined-bg: #1f2024; --fb-declined: #8b8d95;
  --fb-shadow: 0 24px 64px -16px rgb(0 0 0 / 0.6), 0 0 0 1px #2c2d33;
  color-scheme: dark;
}
* { box-sizing: border-box; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
:focus-visible { outline: 2px solid var(--fb-accent); outline-offset: 2px; }

.trigger {
  position: fixed; z-index: 2147483000;
  right: calc(16px + env(safe-area-inset-right)); bottom: calc(16px + env(safe-area-inset-bottom));
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px 0 14px;
  border: 0; border-radius: 999px; background: var(--fb-text); color: var(--fb-surface);
  font-size: 14px; font-weight: 600; letter-spacing: 0.01em; box-shadow: var(--fb-shadow);
  transition: transform 160ms var(--fb-ease), opacity 160ms;
}
.trigger:hover { transform: translateY(-2px); }
.trigger:active { transform: translateY(0) scale(0.97); }
@media (max-width: 379px) { .trigger { padding: 0 13px; } .trigger span { display: none; } }

dialog {
  width: min(440px, calc(100vw - 32px)); height: min(680px, calc(100dvh - 32px)); max-height: none; max-width: none;
  margin: auto 16px 16px auto; padding: 0; border: 0; border-radius: var(--fb-radius);
  background: var(--fb-surface); color: var(--fb-text); box-shadow: var(--fb-shadow);
}
dialog[open] { animation: fb-in 220ms var(--fb-ease); }
dialog::backdrop { background: rgb(10 11 14 / 0.32); }
@keyframes fb-in { from { opacity: 0; transform: translateY(12px); } }
@media (max-width: 640px) {
  dialog { width: 100vw; height: min(88dvh, 720px); margin: auto 0 0; border-radius: var(--fb-radius) var(--fb-radius) 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  dialog[open] { animation: none; }
  .trigger, .vote button { transition: none; }
}
.frame { display: flex; flex-direction: column; height: 100%; }
.frame:focus { outline: none; }

header { display: flex; align-items: flex-start; gap: 12px; padding: 20px 20px 14px; }
header div { flex: 1; min-width: 0; }
h2 { margin: 0; font-size: 18px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--fb-muted); }
.icon-btn { display: grid; place-items: center; width: 36px; height: 36px; margin: -6px -8px 0 0; border: 0; border-radius: 10px; background: transparent; color: var(--fb-muted); }
.icon-btn:hover { background: var(--fb-raised); color: var(--fb-text); }

.toolbar { display: flex; align-items: center; gap: 8px; padding: 0 20px 12px; border-bottom: 1px solid var(--fb-border); }
.filters { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.filters button { flex: none; height: 32px; padding: 0 11px; border: 0; border-radius: 8px; background: transparent; color: var(--fb-muted); font-size: 13px; font-weight: 600; }
.filters button:hover { color: var(--fb-text); background: var(--fb-raised); }
.filters button[aria-pressed="true"] { background: var(--fb-raised); color: var(--fb-text); box-shadow: inset 0 0 0 1px var(--fb-border); }
.new { flex: none; height: 32px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--fb-accent); color: var(--fb-accent-ink); font-size: 13px; font-weight: 700; }
.new:hover { filter: brightness(1.08); }
.new:active { transform: scale(0.97); }

.notice { display: flex; align-items: center; gap: 12px; margin: 12px 20px 0; padding: 10px 12px; border-radius: 10px; background: var(--fb-accent-tint); font-size: 13px; }
.notice span { flex: 1; }
.notice a { color: var(--fb-accent); font-weight: 700; text-decoration: none; }
.notice a:hover { text-decoration: underline; }
.notice button { border: 0; background: transparent; color: var(--fb-muted); font-size: 13px; padding: 4px; }

.scroll { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
ol { list-style: none; margin: 0; padding: 4px 0 24px; }
li { display: grid; grid-template-columns: 44px 1fr; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--fb-border); }
li.fresh { animation: fb-fresh 1.6s var(--fb-ease); }
@keyframes fb-fresh { from { background: var(--fb-accent-tint); } }
.vote { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.vote button { display: grid; place-items: center; width: 36px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--fb-muted); transition: transform 120ms var(--fb-ease); }
.vote button:hover { background: var(--fb-raised); color: var(--fb-text); }
.vote button:active { transform: scale(0.88); }
.vote .up[aria-pressed="true"] { background: var(--fb-accent-tint); color: var(--fb-accent); }
.vote .down[aria-pressed="true"] { background: var(--fb-down-tint); color: var(--fb-down); }
.score { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.4; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }
.kind { background: var(--fb-raised); color: var(--fb-muted); }
.status[data-status="open"] { background: var(--fb-open-bg); color: var(--fb-open); }
.status[data-status="planned"] { background: var(--fb-planned-bg); color: var(--fb-planned); }
.status[data-status="in_progress"] { background: var(--fb-progress-bg); color: var(--fb-progress); }
.status[data-status="shipped"] { background: var(--fb-shipped-bg); color: var(--fb-shipped); }
.status[data-status="declined"] { background: var(--fb-declined-bg); color: var(--fb-declined); }
h3 { margin: 0; font-size: 15px; line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
.body { margin: 4px 0 0; font-size: 14px; line-height: 1.5; color: var(--fb-muted); white-space: pre-line; overflow-wrap: anywhere; }
.body.clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.more { margin-top: 2px; padding: 0; border: 0; background: none; color: var(--fb-accent); font-size: 13px; font-weight: 600; }
.note { margin: 8px 0 0; padding-left: 10px; border-left: 3px solid var(--fb-border); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
li[data-status="shipped"] .note { border-color: var(--fb-shipped); }
li[data-status="planned"] .note, li[data-status="in_progress"] .note { border-color: var(--fb-accent); }
.state { margin: 0; padding: 40px 20px; text-align: center; color: var(--fb-muted); font-size: 14px; }
.state button { margin-top: 10px; border: 1px solid var(--fb-border); border-radius: 8px; background: transparent; padding: 6px 12px; }

form { display: flex; flex-direction: column; gap: 16px; flex: 1; padding: 16px 20px 20px; overflow-y: auto; border-top: 1px solid var(--fb-border); }
fieldset { display: flex; gap: 8px; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: 8px; padding: 0; font-size: 13px; font-weight: 600; }
.kind-option { flex: 1; position: relative; }
.kind-option input { position: absolute; opacity: 0; inset: 0; margin: 0; }
.kind-option span { display: grid; place-items: center; height: 40px; border: 1px solid var(--fb-border); border-radius: 10px; font-size: 14px; font-weight: 600; color: var(--fb-muted); }
.kind-option input:checked + span { border-color: var(--fb-text); background: var(--fb-text); color: var(--fb-surface); }
.kind-option input:focus-visible + span { outline: 2px solid var(--fb-accent); outline-offset: 2px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; }
label small { font-weight: 400; color: var(--fb-muted); }
input[type="text"], textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--fb-border); border-radius: 10px; background: var(--fb-surface); font-size: 16px; font-weight: 400; }
input[type="text"]:focus, textarea:focus { outline: none; border-color: var(--fb-accent); box-shadow: 0 0 0 3px var(--fb-accent-tint); }
textarea { resize: vertical; min-height: 104px; }
.form-error { margin: 0; min-height: 1em; font-size: 13px; color: var(--fb-down); }
.actions { display: flex; gap: 8px; margin-top: auto; }
.actions button { height: 44px; border-radius: 10px; font-size: 14px; font-weight: 700; }
.cancel { flex: 1; border: 1px solid var(--fb-border); background: transparent; }
.cancel:hover { background: var(--fb-raised); }
.send { flex: 2; border: 0; background: var(--fb-accent); color: var(--fb-accent-ink); }
.send:disabled { opacity: 0.45; cursor: not-allowed; }
.toast { position: absolute; left: 50%; bottom: 20px; margin: 0; padding: 9px 14px; border-radius: 999px; background: var(--fb-text); color: var(--fb-surface); font-size: 13px; font-weight: 600; white-space: nowrap; transform: translateX(-50%); pointer-events: none; }
/* Last, so it wins over the base rules above. */
@media (max-width: 360px) {
  header, .toolbar, li, form { padding-left: 16px; padding-right: 16px; }
  .filters button { padding: 0 8px; }
  .notice { margin-left: 16px; margin-right: 16px; }
}
[hidden] { display: none !important; }
`;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(className, icon, label) {
  const button = el('button', { type: 'button', class: className, 'aria-label': label });
  button.innerHTML = ICON[icon]; // constant markup only; never user text
  return button;
}

function rank(items) {
  return [...items].sort((a, b) => b.score - a.score || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

function nextVote(item, value) {
  const myVote = item.myVote === value ? 0 : value;
  return { ...item, myVote, score: item.score - item.myVote + myVote };
}

class FeedbackBoardElement extends HTMLElement {
  static observedAttributes = ['heading', 'label'];

  #adapter = null;
  #items = [];
  #filter = 'all';
  #state = 'idle'; // idle | loading | ready | error
  #pending = new Set();
  #ui = null;
  #toastTimer = 0;
  #sessionKey = null;
  #returnFocus = null;
  #loadSeq = 0;

  get adapter() { return this.#adapter; }
  set adapter(value) {
    this.#adapter = value;
    if (this.#ui?.dialog.open) this.refresh();
  }

  connectedCallback() {
    if (!this.#ui) this.#build();
  }

  attributeChangedCallback() {
    if (!this.#ui) return;
    this.#ui.heading.textContent = this.getAttribute('heading') ?? 'Community feedback';
    this.#ui.triggerLabel.textContent = this.getAttribute('label') ?? 'Feedback';
    this.#ui.trigger.setAttribute('aria-label', this.getAttribute('label') ?? 'Feedback');
  }

  // A per-browser key for anonymous rate limiting (see supabase.sql).
  get sessionKey() {
    if (this.#sessionKey) return this.#sessionKey;
    const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      this.#sessionKey = localStorage.getItem('feedback-board:session');
      if (!this.#sessionKey) {
        this.#sessionKey = fresh();
        localStorage.setItem('feedback-board:session', this.#sessionKey);
      }
    } catch {
      this.#sessionKey ??= fresh();
    }
    return this.#sessionKey;
  }

  open() {
    if (!this.#ui) this.#build();
    if (this.#ui.dialog.open) return;
    // Safari does not focus a button on click, so remember where focus was
    // and fall back to the trigger when the board closes.
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    this.#returnFocus = active && active !== document.body ? active : this.#ui.trigger;
    this.#showList();
    this.#ui.dialog.showModal();
    this.refresh();
  }

  close() {
    this.#ui?.dialog.close();
  }

  async refresh(freshId) {
    if (!this.#adapter) return;
    const seq = ++this.#loadSeq; // only the latest load may render
    this.#state = 'loading';
    this.#renderList();
    try {
      const items = rank(await this.#adapter.list());
      if (seq !== this.#loadSeq) return;
      this.#items = items;
      this.#state = 'ready';
    } catch {
      if (seq !== this.#loadSeq) return;
      this.#state = 'error';
    }
    this.#renderList(freshId);
  }

  #build() {
    const root = this.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLE;

    const label = this.getAttribute('label') ?? 'Feedback';
    // aria-label keeps the name when the text is hidden on narrow screens.
    const trigger = el('button', { type: 'button', class: 'trigger', 'aria-haspopup': 'dialog', 'aria-label': label, part: 'trigger' });
    trigger.innerHTML = ICON.chat;
    const triggerLabel = el('span', { 'aria-hidden': 'true' }, label);
    trigger.append(triggerLabel);
    trigger.addEventListener('click', () => this.open());

    const dialog = el('dialog', { 'aria-labelledby': 'fb-heading', part: 'panel' });
    // showModal() focuses the autofocus element: the panel itself, so screen
    // readers announce the dialog and no focus ring lands on Close.
    const frame = el('div', { class: 'frame', tabindex: '-1', autofocus: '' });
    dialog.append(frame);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) this.close(); });
    dialog.addEventListener('close', () => {
      if (this.#returnFocus?.isConnected) this.#returnFocus.focus({ preventScroll: true });
      this.#returnFocus = null;
    });

    const header = el('header');
    const titles = el('div');
    const heading = el('h2', { id: 'fb-heading' }, this.getAttribute('heading') ?? 'Community feedback');
    titles.append(heading, el('p', { class: 'sub' }, 'Vote on ideas or report a bug.'));
    const closeButton = iconButton('icon-btn', 'close', 'Close');
    closeButton.addEventListener('click', () => this.close());
    header.append(titles, closeButton);

    const toolbar = el('div', { class: 'toolbar' });
    const filters = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter' });
    for (const [value, label] of FILTERS) {
      const button = el('button', { type: 'button', 'data-filter': value, 'aria-pressed': String(value === 'all') }, label);
      button.addEventListener('click', () => { this.#filter = value; this.#renderList(); });
      filters.append(button);
    }
    const newButton = el('button', { type: 'button', class: 'new' }, 'New');
    newButton.addEventListener('click', () => this.#showForm());
    toolbar.append(filters, newButton);

    const notice = el('div', { class: 'notice', role: 'status', hidden: '' });
    const scroll = el('div', { class: 'scroll' });
    const list = el('ol', { 'aria-label': 'Feedback' });
    const state = el('div');
    scroll.append(list, state);

    const form = this.#buildForm();
    const toast = el('p', { class: 'toast', role: 'status', hidden: '' });

    frame.append(header, toolbar, notice, scroll, form, toast);
    root.append(style, trigger, dialog);
    this.#ui = { trigger, triggerLabel, dialog, heading, toolbar, filters, notice, scroll, list, state, form, toast };
  }

  #buildForm() {
    const form = el('form', { hidden: '', novalidate: '' });
    const kinds = el('fieldset');
    kinds.append(el('legend', {}, 'Type'));
    for (const [value, label] of [['bug', 'Bug'], ['feature', 'Idea']]) {
      const option = el('label', { class: 'kind-option' });
      const radio = el('input', { type: 'radio', name: 'kind', value, ...(value === 'feature' ? { checked: '' } : {}) });
      option.append(radio, el('span', {}, label));
      kinds.append(option);
    }
    const titleLabel = el('label', {}, 'Title');
    const title = el('input', { type: 'text', name: 'title', maxlength: '120', autocomplete: 'off', required: '' });
    titleLabel.append(title);
    const bodyLabel = el('label');
    const bodyText = el('span', {}, 'Details ');
    bodyText.append(el('small', {}, '(optional)'));
    bodyLabel.append(bodyText);
    const body = el('textarea', { name: 'body', maxlength: '2000', rows: '4' });
    bodyLabel.append(body);
    const error = el('p', { class: 'form-error', role: 'alert' });
    const actions = el('div', { class: 'actions' });
    const cancel = el('button', { type: 'button', class: 'cancel' }, 'Cancel');
    const send = el('button', { type: 'submit', class: 'send', disabled: '' }, 'Send');
    actions.append(cancel, send);
    form.append(kinds, titleLabel, bodyLabel, error, actions);

    title.addEventListener('input', () => { send.disabled = title.value.trim().length < 3; });
    cancel.addEventListener('click', () => this.#showList());
    form.addEventListener('submit', (event) => { event.preventDefault(); this.#submit(); });
    return form;
  }

  #showList() {
    const { toolbar, notice, scroll, form } = this.#ui;
    form.hidden = true;
    toolbar.hidden = false;
    scroll.hidden = false;
    notice.hidden = true;
  }

  #showForm() {
    const { toolbar, notice, scroll, form } = this.#ui;
    toolbar.hidden = true;
    scroll.hidden = true;
    notice.hidden = true;
    form.hidden = false;
    form.reset();
    form.querySelector('.form-error').textContent = '';
    form.querySelector('.send').disabled = true;
    form.querySelector('input[name="title"]').focus();
  }

  #renderList(freshId) {
    const { filters, list, state } = this.#ui;
    for (const button of filters.children) button.setAttribute('aria-pressed', String(button.dataset.filter === this.#filter));

    const visible = this.#items.filter((item) => {
      if (this.#filter === 'all') return true;
      if (this.#filter === 'shipped') return item.status === 'shipped';
      return item.kind === this.#filter;
    });
    list.replaceChildren(...visible.map((item) => this.#row(item, item.id === freshId)));

    state.replaceChildren();
    if (this.#state === 'loading' && this.#items.length === 0) state.append(el('p', { class: 'state' }, 'Loading…'));
    else if (this.#state === 'error') {
      const retry = el('button', { type: 'button' }, 'Retry');
      retry.addEventListener('click', () => this.refresh());
      const message = el('p', { class: 'state' }, MESSAGES.load);
      message.append(el('br'), retry);
      state.append(message);
    } else if (this.#state === 'ready' && visible.length === 0) {
      state.append(el('p', { class: 'state' }, this.#items.length === 0 ? 'No feedback yet. Add the first.' : 'Nothing here yet.'));
    }
  }

  #row(item, fresh) {
    const li = el('li', { 'data-id': item.id, 'data-status': item.status });
    if (fresh) li.classList.add('fresh');

    const vote = el('div', { class: 'vote' });
    const up = iconButton('up', 'up', `Upvote: ${item.title}`);
    const down = iconButton('down', 'down', `Downvote: ${item.title}`);
    up.setAttribute('aria-pressed', String(item.myVote === 1));
    down.setAttribute('aria-pressed', String(item.myVote === -1));
    up.addEventListener('click', () => this.#vote(item.id, 1));
    down.addEventListener('click', () => this.#vote(item.id, -1));
    vote.append(up, el('span', { class: 'score' }, String(item.score)), down);

    const content = el('div');
    const meta = el('div', { class: 'meta' });
    meta.append(
      el('span', { class: 'chip kind' }, KIND_LABEL[item.kind] ?? item.kind),
      el('span', { class: 'chip status', 'data-status': item.status }, STATUS_LABEL[item.status] ?? item.status),
    );
    content.append(meta, el('h3', {}, item.title));
    if (item.body) {
      const body = el('p', { class: 'body' }, item.body);
      content.append(body);
      if (item.body.length > 180) {
        body.classList.add('clamped');
        const more = el('button', { type: 'button', class: 'more', 'aria-expanded': 'false' }, 'Show more');
        more.addEventListener('click', () => {
          const expanded = body.classList.toggle('clamped') === false;
          more.setAttribute('aria-expanded', String(expanded));
          more.textContent = expanded ? 'Show less' : 'Show more';
        });
        content.append(more);
      }
    }
    if (item.adminNote) content.append(el('p', { class: 'note' }, item.adminNote));
    li.append(vote, content);
    return li;
  }

  // Patch the row in place: re-sorting under the pointer would move it away,
  // and rebuilding it would drop keyboard focus from the pressed button.
  #replaceItem(id, update) {
    this.#items = this.#items.map((item) => (item.id === id ? update(item) : item));
    const row = this.#ui.list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    const item = this.#items.find((it) => it.id === id);
    if (!row || !item) return;
    row.querySelector('.up').setAttribute('aria-pressed', String(item.myVote === 1));
    row.querySelector('.down').setAttribute('aria-pressed', String(item.myVote === -1));
    row.querySelector('.score').textContent = String(item.score);
  }

  async #vote(id, value) {
    if (!this.#adapter || this.#pending.has(id)) return;
    const before = this.#items.find((item) => item.id === id);
    if (!before) return;
    this.#pending.add(id);
    this.#replaceItem(id, (item) => nextVote(item, value));
    try {
      const result = await this.#adapter.vote(id, value);
      const score = Number(result?.score);
      const myVote = Number(result?.myVote);
      if (Number.isFinite(score) && [-1, 0, 1].includes(myVote)) {
        this.#replaceItem(id, (item) => ({ ...item, score, myVote }));
      } else {
        this.refresh(); // the vote was saved; reload rather than show a bad number
      }
    } catch (err) {
      this.#replaceItem(id, () => before);
      this.#handleError(err, 'vote');
    } finally {
      this.#pending.delete(id);
    }
  }

  async #submit() {
    const { form } = this.#ui;
    const data = new FormData(form);
    const input = {
      kind: data.get('kind'),
      title: String(data.get('title') ?? '').trim(),
      body: String(data.get('body') ?? '').trim() || null,
      session: this.sessionKey,
    };
    const send = form.querySelector('.send');
    const error = form.querySelector('.form-error');
    send.disabled = true;
    send.textContent = 'Sending…';
    error.textContent = '';
    let id;
    try {
      ({ id } = await this.#adapter.submit(input));
    } catch (err) {
      const code = err instanceof FeedbackError ? err.code : null;
      if (code === 'not_signed_in' || code === 'not_eligible') {
        this.#showList();
        this.#handleError(err, 'post');
      } else {
        error.textContent = MESSAGES[code] ?? MESSAGES.submit;
      }
      return;
    } finally {
      send.textContent = 'Send';
      send.disabled = form.querySelector('input[name="title"]').value.trim().length < 3;
    }
    // Saved. From here on, a failed reload is a load error, not a failed post,
    // so nobody is told to send it again.
    this.#filter = 'all';
    this.#showList();
    this.#toast(MESSAGES.sent);
    await this.refresh(id);
    this.#ui.list.querySelector('.fresh')?.scrollIntoView({ block: 'nearest' });
  }

  #handleError(err, action) {
    const code = err instanceof FeedbackError ? err.code : null;
    if (code === 'not_signed_in') {
      return this.#notice('feedback-sign-in', `Sign in to ${action}.`, this.getAttribute('sign-in-url'), 'Sign in');
    }
    if (code === 'not_eligible') {
      return this.#notice('feedback-not-eligible', this.getAttribute('gate-note') ?? `Only holders can ${action}.`);
    }
    this.#toast(MESSAGES[code] ?? MESSAGES.vote);
  }

  #notice(eventName, text, href, linkText) {
    const proceed = this.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true, cancelable: true }));
    if (!proceed) return;
    const { notice } = this.#ui;
    const dismiss = el('button', { type: 'button', 'aria-label': 'Dismiss' }, '✕');
    dismiss.addEventListener('click', () => { notice.hidden = true; });
    const parts = [el('span', {}, text)];
    if (href) parts.push(el('a', { href }, linkText));
    notice.replaceChildren(...parts, dismiss);
    notice.hidden = false;
  }

  #toast(text) {
    const { toast } = this.#ui;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  }
}

export function defineFeedbackBoard(tagName = 'feedback-board') {
  if (!customElements.get(tagName)) customElements.define(tagName, class extends FeedbackBoardElement {});
  return customElements.get(tagName);
}
