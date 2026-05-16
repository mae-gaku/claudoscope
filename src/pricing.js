// Token pricing in USD per 1M tokens. Update as Anthropic changes pricing.
// Keys are matched as substrings against the `model` field in JSONL events.
export const MODEL_PRICING = {
  'claude-opus-4-7': {
    input: 15.0,
    output: 75.0,
    cache_read: 1.5,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
  },
  'claude-opus-4': {
    input: 15.0,
    output: 75.0,
    cache_read: 1.5,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
  },
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
  },
  'claude-sonnet-4': {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
  },
  'claude-haiku-4-5': {
    input: 1.0,
    output: 5.0,
    cache_read: 0.1,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
  },
  'claude-haiku-4': {
    input: 1.0,
    output: 5.0,
    cache_read: 0.1,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
  },
};

const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6'];

export function priceFor(model) {
  if (!model) return DEFAULT_PRICING;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.includes(key)) return MODEL_PRICING[key];
  }
  return DEFAULT_PRICING;
}

export function costOf(usage, model) {
  if (!usage) return 0;
  const p = priceFor(model);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const create = usage.cache_creation || {};
  const cacheWrite5m = create.ephemeral_5m_input_tokens || 0;
  const cacheWrite1h = create.ephemeral_1h_input_tokens || 0;
  // If breakdown not provided, fall back to cache_creation_input_tokens treated as 5m
  const fallbackCreate = usage.cache_creation_input_tokens || 0;
  const effective5m = cacheWrite5m || (fallbackCreate - cacheWrite1h > 0 ? fallbackCreate - cacheWrite1h : 0);

  return (
    (input * p.input +
      output * p.output +
      cacheRead * p.cache_read +
      effective5m * p.cache_write_5m +
      cacheWrite1h * p.cache_write_1h) /
    1_000_000
  );
}
