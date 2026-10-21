// Browser tests for reference/feedback-board.js, driven through the demo page.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const panel = (page) => page.getByRole('dialog', { name: 'Community feedback' });
const row = (page, title) => panel(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const score = (page, title) => row(page, title).locator('.score');

async function openBoard(page, query = '') {
  await page.goto(`/reference/demo.html?latency=0${query}`);
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('listitem').first()).toBeVisible();
  // Let the open animation finish so contrast and screenshots see final colors.
  await page.waitForFunction(() =>
    document.querySelector('feedback-board').shadowRoot.querySelector('dialog').getAnimations().length === 0);
}

async function useAdapter(page, code) {
  await page.evaluate(async (source) => {
    const { memoryAdapter } = await import('/reference/memory-adapter.js');
    const { FeedbackError } = await import('/reference/feedback-board.js');
    window.feedbackDemo.board.adapter = new Function('memoryAdapter', 'FeedbackError', `return (${source})`)(memoryAdapter, FeedbackError);
  }, code);
}

test('lists everyone’s feedback, highest score first', async ({ page }) => {
  await openBoard(page);
  const titles = await panel(page).getByRole('heading', { level: 3 }).allTextContents();
  expect(titles[0]).toBe('Dark mode');
  const scores = (await panel(page).locator('.score').allTextContents()).map(Number);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  await expect(row(page, 'Dark mode').getByText('Shipped in 1.4. Follows your system setting.')).toBeVisible();
});

test('votes toggle: up, up again clears, down switches', async ({ page }) => {
  await openBoard(page);
  const up = row(page, 'Keyboard shortcuts').getByRole('button', { name: 'Upvote: Keyboard shortcuts' });
  const down = row(page, 'Keyboard shortcuts').getByRole('button', { name: 'Downvote: Keyboard shortcuts' });
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('3');

  await up.click();
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('4');
  await expect(up).toHaveAttribute('aria-pressed', 'true');

  await up.click();
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('3');
  await expect(up).toHaveAttribute('aria-pressed', 'false');

  await down.click();
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('2');
  await expect(down).toHaveAttribute('aria-pressed', 'true');
  await expect(up).toHaveAttribute('aria-pressed', 'false');
});

test('keyboard voting keeps focus on the button', async ({ page }) => {
  await openBoard(page);
  const up = row(page, 'Keyboard shortcuts').getByRole('button', { name: 'Upvote: Keyboard shortcuts' });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('4');
  await expect(up).toBeFocused();
});

test('rows do not jump while you vote', async ({ page }) => {
  await openBoard(page);
  const before = await panel(page).getByRole('heading', { level: 3 }).allTextContents();
  const up = row(page, 'Keyboard shortcuts').getByRole('button', { name: 'Upvote: Keyboard shortcuts' });
  await up.click();
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('4');
  expect(await panel(page).getByRole('heading', { level: 3 }).allTextContents()).toEqual(before);
});

test('signed-out visitors are asked to sign in and the score does not change', async ({ page }) => {
  await openBoard(page, '&viewer=signed-out');
  await row(page, 'Keyboard shortcuts').getByRole('button', { name: /^Upvote/ }).click();
  await expect(panel(page).getByText('Sign in to vote.')).toBeVisible();
  await expect(panel(page).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '#sign-in');
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('3');
  await expect(row(page, 'Keyboard shortcuts').getByRole('button', { name: /^Upvote/ })).toHaveAttribute('aria-pressed', 'false');
});

test('a wallet without the token sees the gate note', async ({ page }) => {
  await openBoard(page, '&viewer=non-holder');
  await row(page, 'Keyboard shortcuts').getByRole('button', { name: /^Upvote/ }).click();
  await expect(panel(page).getByText('Voting is for holders. Connect a wallet that holds one.')).toBeVisible();
  await expect(score(page, 'Keyboard shortcuts')).toHaveText('3');
});

test('the host can cancel the sign-in event and run its own flow', async ({ page }) => {
  await openBoard(page, '&viewer=signed-out');
  await page.evaluate(() => {
    document.addEventListener('feedback-sign-in', (event) => { event.preventDefault(); window.__signInRequested = true; });
  });
  await row(page, 'Keyboard shortcuts').getByRole('button', { name: /^Upvote/ }).click();
  await expect.poll(() => page.evaluate(() => window.__signInRequested)).toBe(true);
  await expect(panel(page).getByText('Sign in to vote.')).toHaveCount(0);
});

test('posting adds an open item to the board', async ({ page }) => {
  await openBoard(page, '&viewer=signed-out');
  await panel(page).getByRole('button', { name: 'New', exact: true }).click();
  const send = panel(page).getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  await panel(page).getByRole('textbox', { name: 'Title' }).fill('ab');
  await expect(send).toBeDisabled();
  await panel(page).getByRole('textbox', { name: 'Title' }).fill('Search does not find archived posts');
  await panel(page).getByRole('radio', { name: 'Bug' }).check();
  await panel(page).getByRole('textbox', { name: /Details/ }).fill('Steps: archive a post, then search for it.');
  await send.click();

  await expect(panel(page).getByRole('status').filter({ hasText: 'on the board' })).toBeVisible();
  const added = row(page, 'Search does not find archived posts');
  await expect(added).toBeVisible();
  await expect(added.locator('.chip.kind')).toHaveText('Bug');
  await expect(added.locator('.chip.status')).toHaveText('Open');
  await expect(added.locator('.score')).toHaveText('0');
});

test('the sixth post in an hour is rate limited', async ({ page }) => {
  await openBoard(page, '&viewer=member');
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) await window.feedbackDemo.adapter.submit({ kind: 'feature', title: `Idea ${i}` });
  });
  await panel(page).getByRole('button', { name: 'New', exact: true }).click();
  await panel(page).getByRole('textbox', { name: 'Title' }).fill('One more idea');
  await panel(page).getByRole('button', { name: 'Send' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText(/sent a lot in the last hour/);
});

test('user text is rendered as text, never as HTML', async ({ page }) => {
  await openBoard(page);
  await useAdapter(page, `memoryAdapter({ seed: [{
    kind: 'bug',
    title: '<img src=x onerror="window.__xss = 1">',
    body: '<script>window.__xss = 2</script><b>bold?</b>',
    adminNote: '<a href="javascript:window.__xss=3">click</a>',
    up: 1,
  }] })`);
  await expect(panel(page).getByRole('heading', { name: '<img src=x onerror="window.__xss = 1">' })).toBeVisible();
  await expect(panel(page).getByText('<script>window.__xss = 2</script><b>bold?</b>')).toBeVisible();
  await expect(panel(page).getByText('<a href="javascript:window.__xss=3">click</a>')).toBeVisible();
  await expect(panel(page).locator('img, script, b, li a')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('filters narrow the list', async ({ page }) => {
  await openBoard(page);
  const filters = panel(page).getByRole('group', { name: 'Filter' });
  await filters.getByRole('button', { name: 'Shipped' }).click();
  await expect(panel(page).getByRole('heading', { level: 3 })).toHaveText(['Dark mode']);
  await filters.getByRole('button', { name: 'Bugs' }).click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(2);
  await filters.getByRole('button', { name: 'Ideas' }).click();
  await expect(panel(page).getByRole('listitem')).toHaveCount(4);
  await expect(filters.getByRole('button', { name: 'Ideas' })).toHaveAttribute('aria-pressed', 'true');
});

test('a status change from the owner shows on refresh', async ({ page }) => {
  await openBoard(page);
  await page.evaluate(async () => {
    const { adapter, board } = window.feedbackDemo;
    const item = (await adapter.list()).find((it) => it.title === 'Keyboard shortcuts');
    adapter.setStatus(item.id, 'shipped', 'Press ? to see them.');
    await board.refresh();
  });
  await expect(row(page, 'Keyboard shortcuts').locator('.chip.status')).toHaveText('Shipped');
  await expect(row(page, 'Keyboard shortcuts').getByText('Press ? to see them.')).toBeVisible();
});

test('long details are clamped with a toggle', async ({ page }) => {
  await openBoard(page);
  const item = row(page, 'Menu covers the search bar on small phones');
  const toggle = item.getByRole('button', { name: 'Show more' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(item.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
});

test('opening the board moves focus into the panel, then Tab reaches Close', async ({ page }, info) => {
  await openBoard(page);
  const focused = await page.evaluate(() => document.querySelector('feedback-board').shadowRoot.activeElement?.className);
  expect(focused).toBe('frame');
  // Safari skips buttons on Tab unless the user turns that on.
  test.skip(['webkit', 'iphone'].includes(info.project.name), 'Safari does not Tab to buttons by default');
  await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('button', { name: 'Close' })).toBeFocused();
});

test('Escape closes and focus returns to the trigger', async ({ page }) => {
  await openBoard(page);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeFocused();
});

test('clicking the backdrop closes the board', async ({ page }) => {
  await openBoard(page);
  await page.mouse.click(5, 5);
  await expect(panel(page)).toBeHidden();
});

test('an empty board invites the first post', async ({ page }) => {
  await page.goto('/reference/demo.html?latency=0&empty=1');
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(panel(page).getByText('No feedback yet. Add the first.')).toBeVisible();
});

test('a failed load offers a retry', async ({ page }) => {
  await openBoard(page);
  await page.evaluate(() => { window.__fail = true; });
  await useAdapter(page, `(() => {
    const inner = memoryAdapter({ seed: [{ kind: 'feature', title: 'Back again', up: 1 }] });
    return { ...inner, list: async () => { if (window.__fail) throw new Error('down'); return inner.list(); } };
  })()`);
  await expect(panel(page).getByText('Couldn’t load feedback.')).toBeVisible();
  await page.evaluate(() => { window.__fail = false; });
  await panel(page).getByRole('button', { name: 'Retry' }).click();
  await expect(row(page, 'Back again')).toBeVisible();
});

test('a failed vote rolls back and says so', async ({ page }) => {
  await openBoard(page);
  await useAdapter(page, `(() => {
    const inner = memoryAdapter({ seed: [{ id: 'x', kind: 'feature', title: 'Flaky', up: 2 }] });
    return { ...inner, vote: async () => { throw new Error('network'); } };
  })()`);
  await row(page, 'Flaky').getByRole('button', { name: /^Upvote/ }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'Couldn’t save your vote' })).toBeVisible();
  await expect(score(page, 'Flaky')).toHaveText('2');
  await expect(row(page, 'Flaky').getByRole('button', { name: /^Upvote/ })).toHaveAttribute('aria-pressed', 'false');
});

test('a post that saved is not reported as failed when the reload fails', async ({ page }) => {
  await openBoard(page);
  await useAdapter(page, `(() => {
    const inner = memoryAdapter({ seed: [{ kind: 'feature', title: 'Existing', up: 1 }] });
    let lists = 0;
    return { ...inner, list: async () => { lists += 1; if (lists > 1) throw new Error('down'); return inner.list(); } };
  })()`);
  await panel(page).getByRole('button', { name: 'New', exact: true }).click();
  await panel(page).getByRole('textbox', { name: 'Title' }).fill('Saved but reload fails');
  await panel(page).getByRole('button', { name: 'Send' }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'on the board' })).toBeVisible();
  await expect(panel(page).getByText('Couldn’t load feedback.')).toBeVisible();
  await expect(panel(page).getByRole('alert')).toBeHidden();
});

test('a malformed vote response reloads instead of showing a bad number', async ({ page }) => {
  await openBoard(page);
  await useAdapter(page, `(() => {
    const inner = memoryAdapter({ seed: [{ id: 'x', kind: 'feature', title: 'Odd server', up: 2 }] });
    return { ...inner, vote: async (id, value) => { await inner.vote(id, value); return { score: 'oops' }; } };
  })()`);
  await row(page, 'Odd server').getByRole('button', { name: /^Upvote/ }).click();
  await expect(score(page, 'Odd server')).toHaveText('3');
  await expect(row(page, 'Odd server').getByRole('button', { name: /^Upvote/ })).toHaveAttribute('aria-pressed', 'true');
});

test('httpAdapter sends JSON, maps HTTP errors to codes, and accepts a headers function', async ({ page }) => {
  await page.goto('/reference/demo.html?latency=0');
  const result = await page.evaluate(async () => {
    const { httpAdapter, FeedbackError } = await import('/reference/feedback-board.js');
    const calls = [];
    const responses = [
      { status: 200, body: [{ id: 'a', kind: 'bug', title: 'T', status: 'open', admin_note: 'n', score: 2, my_vote: 1 }] },
      { status: 429, body: {} },
      { status: 403, body: { error: 'ballot_used' } },
    ];
    const fakeFetch = async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers, credentials: init.credentials });
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status });
    };
    const api = httpAdapter({ baseUrl: '/api/feedback', fetch: fakeFetch, headers: async () => ({ 'x-csrf': 'tok' }) });
    const items = await api.list();
    const codes = [];
    for (const attempt of [() => api.submit({ kind: 'bug', title: 'x' }), () => api.vote('a/b', 1)]) {
      try { await attempt(); } catch (err) { codes.push(err instanceof FeedbackError ? err.code : 'other'); }
    }
    return { items, codes, calls };
  });
  expect(result.items[0]).toMatchObject({ adminNote: 'n', myVote: 1, score: 2 });
  expect(result.codes).toEqual(['rate_limited', 'ballot_used']);
  expect(result.calls[0]).toMatchObject({ url: '/api/feedback', method: 'GET', credentials: 'same-origin' });
  expect(result.calls[0].headers).toEqual({ 'x-csrf': 'tok' });
  expect(result.calls[1].headers).toEqual({ 'content-type': 'application/json', 'x-csrf': 'tok' });
  expect(result.calls[2].url).toBe('/api/feedback/a%2Fb/vote');
});

test('a token race on an item is explained', async ({ page }) => {
  await openBoard(page);
  await useAdapter(page, `(() => {
    const inner = memoryAdapter({ seed: [{ id: 'x', kind: 'feature', title: 'Holder idea', up: 2 }] });
    return { ...inner, vote: async () => { throw new FeedbackError('ballot_used'); } };
  })()`);
  await row(page, 'Holder idea').getByRole('button', { name: /^Upvote/ }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'just used on this item' })).toBeVisible();
});

for (const colorScheme of ['light', 'dark']) {
  test(`no accessibility violations (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openBoard(page);
    const results = await new AxeBuilder({ page }).include('feedback-board').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

    await panel(page).getByRole('button', { name: 'New', exact: true }).click();
    const form = await new AxeBuilder({ page }).include('feedback-board').analyze();
    expect(form.violations.map((v) => v.id)).toEqual([]);
  });
}

test('reduced motion turns off the open animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openBoard(page);
  const name = await page.evaluate(() => {
    const dialog = document.querySelector('feedback-board').shadowRoot.querySelector('dialog');
    return getComputedStyle(dialog).animationName;
  });
  expect(name).toBe('none');
});

for (const width of [320, 375, 768, 1024, 1440, 1920]) {
  test(`fits the screen at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium' && width !== 320, 'one engine covers the width sweep; all engines check 320px');
    await page.setViewportSize({ width, height: 860 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await openBoard(page);
      const fit = await page.evaluate(() => {
        const dialog = document.querySelector('feedback-board').shadowRoot.querySelector('dialog');
        const box = dialog.getBoundingClientRect();
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          panelOverflow: dialog.scrollWidth - dialog.clientWidth,
          left: box.left,
          right: box.right,
          width: window.innerWidth,
        };
      });
      expect(fit.pageOverflow).toBeLessThanOrEqual(0);
      expect(fit.panelOverflow).toBeLessThanOrEqual(0);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.right).toBeLessThanOrEqual(fit.width);
      await page.screenshot({ path: info.outputPath(`board-${width}-${colorScheme}.png`), animations: 'disabled' });
      await panel(page).getByRole('button', { name: 'New', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`form-${width}-${colorScheme}.png`), animations: 'disabled' });
    }
  });
}
