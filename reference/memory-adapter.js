// In-memory adapter for the demo and tests. Same contract and error codes as a
// real backend, so the widget cannot tell the difference. Not for production:
// nothing persists and nothing is enforced on a server.
import { FeedbackError } from './feedback-board.js';

const KINDS = new Set(['bug', 'feature']);
const HOUR = 60 * 60 * 1000;

// seed: [{ id?, kind, title, body?, status?, adminNote?, up?, down?, createdAt? }]
// viewer(): { id: string | null, eligible?: boolean } — who is using the board right now.
export function memoryAdapter({ seed = [], viewer = () => ({ id: 'demo-user', eligible: true }), latencyMs = 0 } = {}) {
  let items = seed.map((row, i) => ({
    id: row.id ?? `seed-${i + 1}`,
    kind: row.kind,
    title: row.title,
    body: row.body ?? null,
    status: row.status ?? 'open',
    adminNote: row.adminNote ?? null,
    createdAt: row.createdAt ?? new Date(Date.now() - (seed.length - i) * HOUR).toISOString(),
    rateKey: 'seed',
    votes: new Map([
      ...Array.from({ length: row.up ?? 0 }, (_, n) => [`seed-up-${n}`, 1]),
      ...Array.from({ length: row.down ?? 0 }, (_, n) => [`seed-down-${n}`, -1]),
    ]),
  }));

  const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs));
  const score = (item) => [...item.votes.values()].reduce((sum, v) => sum + v, 0);
  const view = (item, voterId) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    status: item.status,
    adminNote: item.adminNote,
    createdAt: item.createdAt,
    score: score(item),
    myVote: (voterId && item.votes.get(voterId)) || 0,
  });

  return {
    async list() {
      await wait();
      const { id } = viewer();
      return items
        .map((item) => view(item, id))
        .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    },

    async submit({ kind, title, body, session } = {}) {
      await wait();
      const { id } = viewer();
      const cleanTitle = String(title ?? '').trim();
      const cleanBody = String(body ?? '').trim() || null;
      if (!KINDS.has(kind)) throw new FeedbackError('invalid_kind');
      if (cleanTitle.length < 3 || cleanTitle.length > 120) throw new FeedbackError('invalid_title');
      if (cleanBody && cleanBody.length > 2000) throw new FeedbackError('invalid_body');
      const rateKey = id ? `user:${id}` : `anon:${session ?? 'none'}`;
      const recent = items.filter((it) => it.rateKey === rateKey && Date.now() - Date.parse(it.createdAt) < HOUR);
      if (recent.length >= 5) throw new FeedbackError('rate_limited');
      const item = {
        id: `item-${Date.now().toString(36)}-${items.length}`,
        kind,
        title: cleanTitle,
        body: cleanBody,
        status: 'open',
        adminNote: null,
        createdAt: new Date().toISOString(),
        rateKey,
        votes: new Map(),
      };
      items = [...items, item];
      return { id: item.id };
    },

    async vote(itemId, value) {
      await wait();
      const { id, eligible = true } = viewer();
      if (!id) throw new FeedbackError('not_signed_in');
      if (!eligible) throw new FeedbackError('not_eligible');
      if (value !== 1 && value !== -1) throw new FeedbackError('invalid_vote');
      const item = items.find((it) => it.id === itemId);
      if (!item) throw new FeedbackError('not_found');
      const votes = new Map(item.votes);
      if (votes.get(id) === value) votes.delete(id);
      else votes.set(id, value);
      const updated = { ...item, votes };
      items = items.map((it) => (it.id === itemId ? updated : it));
      return { score: score(updated), myVote: votes.get(id) ?? 0 };
    },

    // Demo helper, standing in for the owner's feedback_set_status().
    setStatus(itemId, status, adminNote = null) {
      items = items.map((it) => (it.id === itemId ? { ...it, status, adminNote } : it));
    },
  };
}
