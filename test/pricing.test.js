import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, priceFor, MODEL_PRICING } from '../src/pricing.js';

test('priceFor matches a known model substring', () => {
  const p = priceFor('claude-sonnet-4-6-20260101');
  assert.equal(p.input, 3.0);
  assert.equal(p.output, 15.0);
});

test('priceFor falls back to default for unknown model', () => {
  const p = priceFor('not-a-claude-model');
  assert.equal(p.input, MODEL_PRICING['claude-sonnet-4-6'].input);
});

test('costOf computes opus 4.7 pricing correctly', () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  };
  const cost = costOf(usage, 'claude-opus-4-7');
  // $15 input + $75 output + $1.5 cache read + $18.75 cache write (treated as 5m)
  assert.equal(Math.round(cost * 100) / 100, 110.25);
});

test('costOf returns 0 for empty usage', () => {
  assert.equal(costOf(null, 'claude-opus-4-7'), 0);
  assert.equal(costOf({}, 'claude-opus-4-7'), 0);
});

test('costOf respects 5m vs 1h cache_creation breakdown when present', () => {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 500_000,
      ephemeral_1h_input_tokens: 500_000,
    },
  };
  const cost = costOf(usage, 'claude-opus-4-7');
  // 0.5M * 18.75 + 0.5M * 30 = 9.375 + 15 = 24.375
  assert.equal(Math.round(cost * 1000) / 1000, 24.375);
});
