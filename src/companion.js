// Claudoscope AI Companion — deterministic growth engine.
//
// The companion is a tamagotchi-style pet that grows from your Claude Code
// activity. CRITICALLY: this engine performs NO LLM calls. Categorization,
// nutrient derivation, status evolution — all of it is computed from the
// JSONL events Claudoscope already parses. Token cost: zero.
//
// Architecture follows the "魂と声の分離" principle from ai_companion_spec.html:
// only the 魂 (state) is implemented here; the 声 (LLM-generated dialogue) is
// intentionally omitted to keep cost at zero.

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.claudoscope');
export const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'character.json');

// Status bounds.
const MAX = { hp: 100, satiety: 100, mood: 100, affection: 999, knowledge: 9999, creativity: 9999 };
const MIN = { hp: 0, satiety: 0, mood: 0, affection: 0, knowledge: 0, creativity: 0 };

const NUTRITION = {
  code: { knowledge: 3, hp: 1, satiety: 4, mood: 0, exp: 5 },
  learning: { knowledge: 2, creativity: 1, satiety: 3, exp: 4 },
  question: { knowledge: 2, hp: 1, satiety: 2, exp: 3 },
  longform: { creativity: 3, knowledge: 1, satiety: 6, exp: 7 },
  creative: { creativity: 4, mood: 1, satiety: 3, exp: 5 },
  chat: { affection: 2, mood: 2, satiety: 2, exp: 2 },
  delegate: { knowledge: 1, satiety: 1, exp: 3 },
  search: { knowledge: 2, creativity: 1, satiety: 2, exp: 3 },
  other: { satiety: 1, exp: 1 },
};

const TOOL_CATEGORY = (name) => {
  if (!name) return null;
  if (/^(Read|Edit|Write|MultiEdit|NotebookEdit|Bash|BashOutput|KillShell)$/i.test(name)) return 'code';
  if (/^(Grep|Glob|Find)$/i.test(name)) return 'search';
  if (/^(WebFetch|WebSearch)$/i.test(name)) return 'learning';
  if (/^(Task|Agent|Skill)$/i.test(name)) return 'delegate';
  return null;
};

// Categorize one event. Pure function. No LLM.
export function categorize(ev) {
  if (!ev) return 'other';
  if (ev.kind === 'assistant_message') {
    const tools = (ev.tools || []).map((t) => TOOL_CATEGORY(t.name)).filter(Boolean);
    if (tools.length) {
      // Pick the dominant tool category.
      const counts = {};
      for (const c of tools) counts[c] = (counts[c] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }
    const text = ev.text || '';
    if (text.length > 600) return 'longform';
    if (/```|function |class |const |let |def |import /.test(text)) return 'code';
    return 'chat';
  }
  if (ev.kind === 'user_message') {
    const text = ev.text || '';
    if (/```|function |class |const |let |def |import /.test(text)) return 'code';
    if (text.length > 300) return 'longform';
    if (/\?|どう|なぜ|how |why |what |which /i.test(text)) return 'question';
    if (/書いて|作って|考えて|create |write |design |idea/i.test(text)) return 'creative';
    return 'chat';
  }
  if (ev.kind === 'tool_result') return 'other';
  return 'other';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function expForLevel(L) {
  return Math.floor(100 * Math.pow(L, 1.4));
}

export function levelFromExp(exp) {
  let lvl = 1;
  while (exp >= expForLevel(lvl + 1)) lvl++;
  return lvl;
}

function chooseEvolutionBranch(s) {
  // Largest dominant status determines branch when crossing milestones.
  const stats = {
    knowledge: s.knowledge,
    creative: s.creativity,
    social: s.affection,
  };
  const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  const [top, second] = sorted;
  if (!top[1]) return 'balanced';
  // If top is more than 1.4x second, commit; else balanced.
  if (top[1] >= (second[1] || 1) * 1.4) return top[0];
  return 'balanced';
}

const EVOLUTION_MILESTONES = [5, 10, 20, 50];

// Generate a new character with a stable color seed.
export function createCharacter({ name = 'Claudie', now = Date.now() } = {}) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name,
    colorSeed: Math.floor(Math.random() * 360),
    bornAt: now,
    level: 1,
    exp: 0,
    hp: 80,
    satiety: 60,
    knowledge: 0,
    creativity: 0,
    affection: 10,
    mood: 70,
    evolutionStage: 0,
    evolutionBranch: 'baby',
    accessories: [],
    state: 'idle',
    lastInteractionAt: now,
    lastSeenEventTs: 0,
    // Recent activity log shown to the user (kept tiny).
    recent: [],
    // Counters that survive resets.
    totals: { events: 0, prompts: 0, toolCalls: 0, limitHits: 0 },
  };
}

// Apply one event to the state. Pure function — returns a new state.
export function applyEvent(state, ev, { now = Date.now() } = {}) {
  if (!state) state = createCharacter({ now });
  if (!ev) return state;
  // Skip events we've already consumed.
  if (ev.ts && state.lastSeenEventTs && ev.ts <= state.lastSeenEventTs) return state;

  const cat = categorize(ev);
  const nutrients = NUTRITION[cat] || NUTRITION.other;

  const next = { ...state, totals: { ...state.totals } };
  next.hp = clamp((next.hp || 0) + (nutrients.hp || 0), MIN.hp, MAX.hp);
  next.satiety = clamp((next.satiety || 0) + (nutrients.satiety || 0), MIN.satiety, MAX.satiety);
  next.mood = clamp((next.mood || 0) + (nutrients.mood || 0), MIN.mood, MAX.mood);
  next.affection = clamp((next.affection || 0) + (nutrients.affection || 0), MIN.affection, MAX.affection);
  next.knowledge = clamp((next.knowledge || 0) + (nutrients.knowledge || 0), MIN.knowledge, MAX.knowledge);
  next.creativity = clamp((next.creativity || 0) + (nutrients.creativity || 0), MIN.creativity, MAX.creativity);
  next.exp = (next.exp || 0) + (nutrients.exp || 0);
  next.totals.events++;
  if (ev.kind === 'user_message') next.totals.prompts++;
  if (ev.kind === 'assistant_message' && ev.tools?.length) next.totals.toolCalls += ev.tools.length;

  // Mood penalty for tool errors.
  if (ev.kind === 'tool_result') {
    const errs = (ev.toolResults || []).filter((r) => r.is_error).length;
    if (errs > 0) next.mood = clamp(next.mood - errs, MIN.mood, MAX.mood);
  }

  // Rate-limit hits sap mood and bump a counter.
  if (cat === 'other' && ev.kind === 'assistant_message' && /hit your limit/i.test(ev.text || '')) {
    next.mood = clamp(next.mood - 10, MIN.mood, MAX.mood);
    next.totals.limitHits++;
  }

  if (ev.ts) {
    next.lastSeenEventTs = Math.max(next.lastSeenEventTs || 0, ev.ts);
    next.lastInteractionAt = Math.max(next.lastInteractionAt || 0, ev.ts);
  } else {
    next.lastInteractionAt = now;
  }

  // Level up.
  const newLevel = levelFromExp(next.exp);
  if (newLevel > next.level) {
    // Check evolution milestone crossing.
    for (const m of EVOLUTION_MILESTONES) {
      if (next.level < m && newLevel >= m) {
        next.evolutionStage = EVOLUTION_MILESTONES.indexOf(m) + 1;
        next.evolutionBranch = chooseEvolutionBranch(next);
        pushRecent(next, `🌱 Evolved → Lv.${m} (${next.evolutionBranch})`, now);
      }
    }
    pushRecent(next, `⬆ Level up! Lv.${newLevel}`, now);
    next.level = newLevel;
  }

  pushRecent(next, `+${nutrients.exp || 0} xp (${cat})`, now);
  next.state = deriveState(next, now);
  return next;
}

function pushRecent(state, msg, ts) {
  if (!state.recent) state.recent = [];
  state.recent.push({ ts, msg });
  if (state.recent.length > 20) state.recent.shift();
}

// Decay over time. Run periodically.
export function tickDecay(state, { now = Date.now() } = {}) {
  if (!state) return state;
  const next = { ...state };
  // Satiety decays slowly (full → empty over ~24h)
  next.satiety = clamp((next.satiety || 0) - 0.07, MIN.satiety, MAX.satiety);
  // Mood drifts toward 50 when idle for long
  const idleMs = now - (next.lastInteractionAt || now);
  if (idleMs > 30 * 60 * 1000) {
    // After 30min idle, mood and hp slowly approach baseline
    const baseline = 50;
    next.mood = next.mood + (baseline - next.mood) * 0.005;
    next.hp = clamp((next.hp || 0) - 0.02, MIN.hp, MAX.hp);
  }
  next.state = deriveState(next, now);
  return next;
}

export function deriveState(state, now = Date.now()) {
  const idleMs = now - (state.lastInteractionAt ?? now);
  if (idleMs > 24 * 60 * 60 * 1000) return 'sulking';
  if (idleMs > 4 * 60 * 60 * 1000) return 'sleepy';
  if (state.satiety < 20) return 'hungry';
  if (state.mood > 85 && state.hp > 70) return 'excited';
  if (state.mood < 30) return 'sad';
  if (idleMs < 30 * 1000 && state.totals.events > 0) return 'happy';
  return 'idle';
}

// Petting interaction — pure function, no event needed.
export function pet(state, { now = Date.now() } = {}) {
  if (!state) state = createCharacter({ now });
  const next = { ...state, totals: { ...state.totals } };
  next.affection = clamp((next.affection || 0) + 2, MIN.affection, MAX.affection);
  next.mood = clamp((next.mood || 0) + 5, MIN.mood, MAX.mood);
  next.hp = clamp((next.hp || 0) + 1, MIN.hp, MAX.hp);
  next.lastInteractionAt = now;
  pushRecent(next, '❤ pet (+5 mood, +2 affection)', now);
  next.state = deriveState(next, now);
  return next;
}

// Manual rename.
export function rename(state, name, { now = Date.now() } = {}) {
  const next = { ...state, name: String(name || '').slice(0, 32) || state.name };
  pushRecent(next, `📛 Renamed to ${next.name}`, now);
  return next;
}

// CompanionStore — wraps state persistence and emits 'change' on updates.
export class CompanionStore extends EventEmitter {
  constructor({ statePath = DEFAULT_STATE_FILE } = {}) {
    super();
    this.statePath = statePath;
    this.state = null;
    this._saveTimer = null;
    this._dirty = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      this.state = JSON.parse(raw);
    } catch {
      this.state = createCharacter();
      this._dirty = true;
    }
    return this.state;
  }

  async save() {
    const dir = path.dirname(this.statePath);
    if (!fsSync.existsSync(dir)) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
    this._dirty = false;
  }

  start({ saveIntervalMs = 30_000, decayIntervalMs = 60_000 } = {}) {
    this._saveTimer = setInterval(async () => {
      if (this._dirty) {
        try { await this.save(); } catch {}
      }
    }, saveIntervalMs);
    this._decayTimer = setInterval(() => {
      this.state = tickDecay(this.state);
      this._dirty = true;
      this.emit('change', this.state);
    }, decayIntervalMs);
  }

  stop() {
    if (this._saveTimer) clearInterval(this._saveTimer);
    if (this._decayTimer) clearInterval(this._decayTimer);
  }

  applyEvents(events) {
    if (!events || !events.length) return;
    let changed = false;
    for (const ev of events) {
      const next = applyEvent(this.state, ev);
      if (next !== this.state) {
        this.state = next;
        changed = true;
      }
    }
    if (changed) {
      this._dirty = true;
      this.emit('change', this.state);
    }
  }

  pet() {
    this.state = pet(this.state);
    this._dirty = true;
    this.emit('change', this.state);
    return this.state;
  }

  rename(name) {
    this.state = rename(this.state, name);
    this._dirty = true;
    this.emit('change', this.state);
    return this.state;
  }

  reset() {
    this.state = createCharacter();
    this._dirty = true;
    this.emit('change', this.state);
    return this.state;
  }
}
