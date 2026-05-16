import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, aggregate, decodeProjectDir, resolvePlan, PLAN_PRESETS } from '../src/parser.js';

test('decodeProjectDir converts encoded slug back to path', () => {
  assert.equal(decodeProjectDir('-home-alice-projects-app'), '/home/alice/projects/app');
  assert.equal(decodeProjectDir('plain'), 'plain');
});

test('parseLine handles assistant message with usage and tools', () => {
  const line = JSON.stringify({
    type: 'assistant',
    sessionId: 'abc',
    timestamp: '2026-05-16T01:00:00.000Z',
    cwd: '/tmp',
    message: {
      model: 'claude-sonnet-4-6-20260101',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 't1', name: 'Read' },
      ],
    },
  });
  const ev = parseLine(line, '/p/s.jsonl');
  assert.equal(ev.kind, 'assistant_message');
  assert.equal(ev.model, 'claude-sonnet-4-6-20260101');
  assert.equal(ev.tools.length, 1);
  assert.equal(ev.tools[0].name, 'Read');
  assert.ok(ev.cost > 0);
});

test('parseLine handles user tool_result', () => {
  const line = JSON.stringify({
    type: 'user',
    sessionId: 'abc',
    timestamp: '2026-05-16T01:00:00.000Z',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }],
    },
  });
  const ev = parseLine(line, '/p/s.jsonl');
  assert.equal(ev.kind, 'tool_result');
  assert.equal(ev.toolResults[0].is_error, true);
});

test('parseLine handles plain user text message', () => {
  const line = JSON.stringify({
    type: 'user',
    sessionId: 'abc',
    message: { content: 'hi claude' },
  });
  const ev = parseLine(line, '/p/s.jsonl');
  assert.equal(ev.kind, 'user_message');
  assert.equal(ev.text, 'hi claude');
});

test('parseLine returns null for non-JSON lines', () => {
  assert.equal(parseLine('not json', '/p/s.jsonl'), null);
});

test('parseLine marks events without a timestamp as hasTs=false', () => {
  const line = JSON.stringify({ type: 'permission-mode', sessionId: 'abc', permissionMode: 'default' });
  const ev = parseLine(line, '/p/s.jsonl');
  assert.equal(ev.hasTs, false);
});

test('resolvePlan honors preset names and custom budget overrides', () => {
  assert.equal(resolvePlan({ plan: 'pro' }).budget, PLAN_PRESETS.pro.budget);
  assert.equal(resolvePlan({ plan: 'max20' }).budget, PLAN_PRESETS.max20.budget);
  assert.equal(resolvePlan({ plan: 'bogus' }).budget, PLAN_PRESETS.api.budget);
  const c = resolvePlan({ plan: 'pro', budget: 42 });
  assert.equal(c.name, 'custom');
  assert.equal(c.budget, 42);
});

test('aggregate filters <synthetic> from byModel and counts limit hits', () => {
  const now = Date.now();
  const events = [
    {
      kind: 'assistant_message',
      ts: now - 60_000,
      hasTs: true,
      sessionId: 's1',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: 0.005,
      tools: [],
    },
    {
      kind: 'assistant_message',
      ts: now - 30_000,
      hasTs: true,
      sessionId: 's1',
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      cost: 0,
      tools: [],
      text: "You've hit your limit · resets 2am",
    },
  ];
  const snap = aggregate(events, now, { plan: PLAN_PRESETS.pro });
  assert.equal(snap.byModel.length, 1);
  assert.equal(snap.byModel[0].model, 'claude-opus-4-7');
  assert.equal(snap.totals.limitHits, 1);
  assert.equal(snap.last5h.limitHits, 1);
  assert.equal(snap.last5h.cost, 0.005);
  assert.equal(snap.plan.name, 'pro');
});

test('aggregate 5h window respects time horizon', () => {
  const now = Date.now();
  const events = [
    // Inside 5h window
    {
      kind: 'assistant_message',
      ts: now - 60_000,
      hasTs: true,
      sessionId: 's-recent',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 100 },
      cost: 1.0,
      tools: [{ id: 'a', name: 'Read' }],
    },
    // Outside 5h window
    {
      kind: 'assistant_message',
      ts: now - 6 * 60 * 60 * 1000,
      hasTs: true,
      sessionId: 's-old',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 100 },
      cost: 5.0,
      tools: [{ id: 'b', name: 'Edit' }],
    },
  ];
  const snap = aggregate(events, now, { plan: PLAN_PRESETS.pro });
  assert.equal(snap.last5h.cost, 1.0);
  assert.equal(snap.last5h.messages, 1);
  assert.equal(snap.last5h.toolCalls, 1);
  assert.equal(snap.last5h.sessions, 1);
  // Lifetime sees both
  assert.equal(snap.totals.cost, 6.0);
  assert.equal(snap.last5h.usedPct, (1.0 / PLAN_PRESETS.pro.budget) * 100);
});

test('aggregate does not mark a session active solely from a timestamp-less event', () => {
  const now = Date.now();
  const events = [
    // Old real message — well outside the 5-minute active window
    {
      kind: 'user_message',
      ts: now - 60 * 60 * 1000,
      hasTs: true,
      sessionId: 's-old',
      cwd: '/p',
      text: 'hello',
    },
    // Timestamp-less event (e.g. permission-mode) — must not refresh activity
    {
      kind: 'permission_mode',
      ts: now,
      hasTs: false,
      sessionId: 's-old',
    },
  ];
  const snap = aggregate(events, now);
  assert.equal(snap.totals.activeSessions, 0);
});

test('aggregate computes totals, byTool, and bucket breakdown', () => {
  const now = Date.now();
  const events = [
    {
      kind: 'assistant_message',
      ts: now - 30_000,
      hasTs: true,
      sessionId: 's1',
      cwd: '/proj',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      cost: 0.001,
      tools: [{ id: 'a', name: 'Read' }, { id: 'b', name: 'Edit' }],
    },
    {
      kind: 'tool_result',
      ts: now - 20_000,
      hasTs: true,
      sessionId: 's1',
      toolResults: [{ tool_use_id: 'a', is_error: false }, { tool_use_id: 'b', is_error: true }],
    },
    {
      kind: 'user_message',
      ts: now - 10_000,
      hasTs: true,
      sessionId: 's1',
      cwd: '/proj',
      text: 'hello',
    },
  ];
  const snap = aggregate(events, now);
  assert.equal(snap.totals.sessions, 1);
  assert.equal(snap.totals.toolCalls, 2);
  assert.equal(snap.totals.toolErrors, 1);
  assert.equal(snap.totals.tokens.input, 100);
  assert.equal(snap.totals.tokens.output, 50);
  assert.equal(snap.byTool.find((t) => t.name === 'Read').calls, 1);
  assert.equal(snap.byProject[0].cwd, '/proj');
  // The last bucket (current minute) should reflect the assistant message
  const lastBucket = snap.timeline[snap.timeline.length - 1];
  assert.equal(lastBucket.tokens_in, 100);
  assert.equal(lastBucket.tokens_out, 50);
  assert.equal(lastBucket.tokens_cache, 15);
});
