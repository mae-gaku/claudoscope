import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorize,
  applyEvent,
  tickDecay,
  pet,
  createCharacter,
  deriveState,
  expForLevel,
  levelFromExp,
} from '../src/companion.js';

test('categorize picks code when tool list is dominated by Read/Edit/Bash', () => {
  const ev = {
    kind: 'assistant_message',
    tools: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }],
    text: '',
  };
  assert.equal(categorize(ev), 'code');
});

test('categorize picks learning for WebFetch', () => {
  const ev = { kind: 'assistant_message', tools: [{ name: 'WebFetch' }] };
  assert.equal(categorize(ev), 'learning');
});

test('categorize falls back to text-based classification for code blocks', () => {
  const ev = { kind: 'user_message', text: '```js\nconst x = 1;\n```' };
  assert.equal(categorize(ev), 'code');
});

test('categorize detects questions and creative prompts in user messages', () => {
  assert.equal(categorize({ kind: 'user_message', text: 'why does this happen?' }), 'question');
  assert.equal(categorize({ kind: 'user_message', text: 'write me a poem' }), 'creative');
  assert.equal(categorize({ kind: 'user_message', text: 'lol ok thanks' }), 'chat');
});

test('expForLevel and levelFromExp are inverse-consistent', () => {
  for (let L = 1; L < 30; L++) {
    const exp = expForLevel(L);
    assert.ok(levelFromExp(exp) >= L, `level ${L} should be reachable at exp ${exp}`);
  }
});

test('applyEvent never spends LLM tokens (pure function) and increments XP', () => {
  const initial = createCharacter({ now: 1_000_000 });
  const ev = {
    kind: 'assistant_message',
    ts: 1_001_000,
    tools: [{ name: 'Read' }],
    text: 'looked at file',
  };
  const next = applyEvent(initial, ev);
  assert.ok(next.exp > initial.exp, 'exp should increase');
  assert.ok(next.knowledge > initial.knowledge, 'knowledge should increase');
  assert.notEqual(next, initial, 'should return a new state object');
});

test('applyEvent is idempotent for duplicate events (deduped by ts)', () => {
  let state = createCharacter({ now: 1_000_000 });
  const ev = { kind: 'assistant_message', ts: 2_000_000, tools: [{ name: 'Read' }] };
  state = applyEvent(state, ev);
  const xpAfterFirst = state.exp;
  state = applyEvent(state, ev);
  assert.equal(state.exp, xpAfterFirst, 'duplicate event must not double-count');
});

test('applyEvent triggers level up and records it in recent log', () => {
  let state = createCharacter({ now: 1_000_000 });
  // Feed a bunch of high-XP longform events
  for (let i = 0; i < 50; i++) {
    state = applyEvent(state, {
      kind: 'assistant_message',
      ts: 1_000_000 + i * 1000,
      tools: [],
      text: 'x'.repeat(700), // longform
    });
  }
  assert.ok(state.level >= 2, `expected to level up, got Lv.${state.level}`);
  const hasLevelMsg = (state.recent || []).some((r) => /Level up/.test(r.msg));
  assert.ok(hasLevelMsg, 'should record level up message');
});

test('tool errors reduce mood', () => {
  let state = createCharacter({ now: 1_000_000 });
  const before = state.mood;
  state = applyEvent(state, {
    kind: 'tool_result',
    ts: 2_000_000,
    toolResults: [{ is_error: true }, { is_error: true }],
  });
  assert.ok(state.mood < before, 'mood should drop after errors');
});

test('pet boosts mood and affection without any event input', () => {
  const a = createCharacter({ now: 1_000_000 });
  const b = pet(a, { now: 1_000_100 });
  assert.ok(b.mood > a.mood);
  assert.ok(b.affection > a.affection);
});

test('deriveState transitions to sleepy/sulking based on idle time', () => {
  const s = createCharacter({ now: 0 });
  s.lastInteractionAt = 0;
  assert.equal(deriveState(s, 5 * 60 * 60 * 1000), 'sleepy');
  assert.equal(deriveState(s, 25 * 60 * 60 * 1000), 'sulking');
});

test('tickDecay slowly drops satiety', () => {
  const a = createCharacter({ now: 0 });
  const b = tickDecay(a, { now: 0 });
  assert.ok(b.satiety <= a.satiety);
});
