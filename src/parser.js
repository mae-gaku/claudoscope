import { promises as fs } from 'node:fs';
import path from 'node:path';
import { costOf } from './pricing.js';

// Decode a Claude Code project directory name back to a readable path.
// Claude Code encodes paths like /home/user/foo -> -home-user-foo
export function decodeProjectDir(name) {
  if (!name.startsWith('-')) return name;
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

// Parse one JSONL line into a normalized event, or null if irrelevant.
export function parseLine(line, sessionFile) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const type = obj.type;
  // Some Claude Code JSONL entries (e.g. permission-mode, file-history-snapshot) have
  // no `timestamp`. Mark those with hasTs=false so aggregate() does not treat them as
  // recent activity.
  const hasTs = !!obj.timestamp;
  const ts = hasTs ? new Date(obj.timestamp).getTime() : Date.now();
  const sessionId = obj.sessionId || path.basename(sessionFile, '.jsonl');

  const base = {
    type,
    ts,
    hasTs,
    sessionId,
    cwd: obj.cwd,
    gitBranch: obj.gitBranch,
    version: obj.version,
    uuid: obj.uuid,
  };

  if (type === 'user') {
    const msg = obj.message || {};
    const content = msg.content;
    // Tool results come back as user messages with content arrays
    if (Array.isArray(content)) {
      const toolResults = content.filter((c) => c && c.type === 'tool_result');
      if (toolResults.length > 0) {
        return {
          ...base,
          kind: 'tool_result',
          toolResults: toolResults.map((r) => ({
            tool_use_id: r.tool_use_id,
            is_error: !!r.is_error,
          })),
        };
      }
    }
    const text = typeof content === 'string' ? content : '';
    return { ...base, kind: 'user_message', text: text.slice(0, 500) };
  }

  if (type === 'assistant') {
    const msg = obj.message || {};
    const usage = msg.usage || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const tools = content
      .filter((c) => c && c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name }));
    const thinking = content.some((c) => c && c.type === 'thinking');
    const text = content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    return {
      ...base,
      kind: 'assistant_message',
      model: msg.model,
      usage,
      cost: costOf(usage, msg.model),
      tools,
      thinking,
      text: text.slice(0, 500),
    };
  }

  if (type === 'attachment') return null; // noisy, skip
  if (type === 'file-history-snapshot') return null;
  if (type === 'permission-mode') {
    return { ...base, kind: 'permission_mode', mode: obj.permissionMode };
  }

  return { ...base, kind: 'other' };
}

// Read an entire JSONL file and return parsed events.
export async function readSessionFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const ev = parseLine(line, filePath);
    if (ev) events.push(ev);
  }
  return events;
}

// Aggregate raw events into dashboard-ready metrics.
// `opts.plan` is { name, budget } — used to compute % of 5h session window used.
export function aggregate(events, now = Date.now(), opts = {}) {
  const total = {
    sessions: new Set(),
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
  };

  // Rolling 5h window — used to estimate Claude Code session quota usage.
  const FIVE_HOURS = 5 * 60 * 60 * 1000;
  const last5h = {
    windowMs: FIVE_HOURS,
    since: now - FIVE_HOURS,
    messages: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    sessions: new Set(),
    limitHits: 0,
  };
  // Lifetime limit-hit counter (from <synthetic> messages with "hit your limit" text)
  let limitHits = 0;

  const byModel = {};
  const byTool = {};
  const byProject = {};
  const bySession = {};
  // 60 buckets of 1 minute each = last 60 minutes
  const timelineMinutes = 60;
  const minuteBuckets = Array.from({ length: timelineMinutes }, (_, i) => ({
    t: Math.floor(now / 60000) * 60000 - (timelineMinutes - 1 - i) * 60000,
    tokens: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache: 0,
    cost: 0,
    tools: 0,
    messages: 0,
  }));
  const bucketFor = (ev) => {
    if (!ev.hasTs) return null;
    const idx = timelineMinutes - 1 - Math.floor((now - ev.ts) / 60000);
    if (idx < 0 || idx >= timelineMinutes) return null;
    return minuteBuckets[idx];
  };

  for (const ev of events) {
    total.sessions.add(ev.sessionId);
    const sid = ev.sessionId;
    if (!bySession[sid]) {
      bySession[sid] = {
        sessionId: sid,
        cwd: ev.cwd,
        gitBranch: ev.gitBranch,
        firstTs: ev.hasTs ? ev.ts : null,
        lastTs: ev.hasTs ? ev.ts : 0,
        messages: 0,
        toolCalls: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        cost: 0,
        lastTool: null,
        lastUserText: null,
        lastAssistantText: null,
      };
    }
    const s = bySession[sid];
    // Only events with a real timestamp count toward session activity.
    if (ev.hasTs) {
      s.lastTs = Math.max(s.lastTs, ev.ts);
      if (s.firstTs == null) s.firstTs = ev.ts;
    }
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.gitBranch !== undefined) s.gitBranch = ev.gitBranch;

    if (ev.kind === 'user_message') {
      total.messages++;
      total.userMessages++;
      s.messages++;
      if (ev.text) s.lastUserText = ev.text;
      const b = bucketFor(ev);
      if (b) b.messages++;
    }

    if (ev.kind === 'assistant_message') {
      total.messages++;
      total.assistantMessages++;
      s.messages++;
      const usage = ev.usage || {};
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheWrite = usage.cache_creation_input_tokens || 0;
      const model = ev.model || 'unknown';
      // <synthetic> messages are Claude Code's own UI artifacts (e.g. rate-limit notices)
      // — they have all-zero usage and shouldn't show up in the model breakdown.
      const isSynthetic = model === '<synthetic>';
      if (isSynthetic && /hit your limit/i.test(ev.text || '')) {
        limitHits++;
        if (ev.hasTs && ev.ts >= last5h.since) last5h.limitHits++;
      }
      total.tokens.input += input;
      total.tokens.output += output;
      total.tokens.cache_read += cacheRead;
      total.tokens.cache_write += cacheWrite;
      total.cost += ev.cost || 0;
      s.tokens.input += input;
      s.tokens.output += output;
      s.tokens.cache_read += cacheRead;
      s.tokens.cache_write += cacheWrite;
      s.cost += ev.cost || 0;
      if (ev.text) s.lastAssistantText = ev.text;

      // 5-hour rolling totals (used for Claude Code session-quota estimation).
      if (ev.hasTs && ev.ts >= last5h.since && !isSynthetic) {
        last5h.messages++;
        last5h.sessions.add(sid);
        last5h.tokens.input += input;
        last5h.tokens.output += output;
        last5h.tokens.cache_read += cacheRead;
        last5h.tokens.cache_write += cacheWrite;
        last5h.cost += ev.cost || 0;
        last5h.toolCalls += (ev.tools || []).length;
      }

      if (!isSynthetic) {
        if (!byModel[model]) {
          byModel[model] = {
            model,
            calls: 0,
            tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            cost: 0,
          };
        }
        byModel[model].calls++;
        byModel[model].tokens.input += input;
        byModel[model].tokens.output += output;
        byModel[model].tokens.cache_read += cacheRead;
        byModel[model].tokens.cache_write += cacheWrite;
        byModel[model].cost += ev.cost || 0;
      }

      const b = bucketFor(ev);
      if (b) {
        b.tokens += input + output + cacheRead + cacheWrite;
        b.tokens_in += input;
        b.tokens_out += output;
        b.tokens_cache += cacheRead + cacheWrite;
        b.cost += ev.cost || 0;
        b.messages++;
      }

      for (const t of ev.tools || []) {
        total.toolCalls++;
        s.toolCalls++;
        s.lastTool = t.name;
        if (!byTool[t.name]) byTool[t.name] = { name: t.name, calls: 0, errors: 0 };
        byTool[t.name].calls++;
        if (b) b.tools++;
      }
    }

    if (ev.kind === 'tool_result') {
      for (const r of ev.toolResults || []) {
        if (r.is_error) {
          total.toolErrors++;
          // We don't know which tool from result alone; counted in total only.
        }
      }
    }

    if (ev.cwd) {
      const proj = ev.cwd;
      if (!byProject[proj]) {
        byProject[proj] = {
          cwd: proj,
          messages: 0,
          toolCalls: 0,
          tokens: 0,
          cost: 0,
          sessions: new Set(),
        };
      }
      byProject[proj].sessions.add(sid);
      if (ev.kind === 'assistant_message') {
        const u = ev.usage || {};
        byProject[proj].messages++;
        byProject[proj].tokens +=
          (u.input_tokens || 0) +
          (u.output_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        byProject[proj].cost += ev.cost || 0;
        byProject[proj].toolCalls += (ev.tools || []).length;
      } else if (ev.kind === 'user_message') {
        byProject[proj].messages++;
      }
    }
  }

  const projectsArr = Object.values(byProject).map((p) => ({
    ...p,
    sessions: p.sessions.size,
  }));

  const sessionsArr = Object.values(bySession).sort((a, b) => b.lastTs - a.lastTs);
  // Active = had activity in last 5 minutes
  const activeCutoff = now - 5 * 60 * 1000;
  const activeSessions = sessionsArr.filter((s) => s.lastTs >= activeCutoff);

  const plan = opts.plan || DEFAULT_PLAN;
  const last5hTokens =
    last5h.tokens.input + last5h.tokens.output + last5h.tokens.cache_read + last5h.tokens.cache_write;
  const usedPct = plan.budget > 0 ? Math.min(100, (last5h.cost / plan.budget) * 100) : 0;

  return {
    generatedAt: now,
    plan: { name: plan.name, budget: plan.budget, label: plan.label },
    totals: {
      sessions: total.sessions.size,
      activeSessions: activeSessions.length,
      messages: total.messages,
      userMessages: total.userMessages,
      assistantMessages: total.assistantMessages,
      toolCalls: total.toolCalls,
      toolErrors: total.toolErrors,
      tokens: total.tokens,
      cost: total.cost,
      limitHits,
    },
    last5h: {
      windowMs: last5h.windowMs,
      since: last5h.since,
      messages: last5h.messages,
      toolCalls: last5h.toolCalls,
      sessions: last5h.sessions.size,
      tokens: last5h.tokens,
      tokensTotal: last5hTokens,
      cost: last5h.cost,
      limitHits: last5h.limitHits,
      usedPct,
      remainingBudget: Math.max(0, plan.budget - last5h.cost),
    },
    byModel: Object.values(byModel).sort((a, b) => b.cost - a.cost),
    byTool: Object.values(byTool).sort((a, b) => b.calls - a.calls),
    byProject: projectsArr.sort((a, b) => b.cost - a.cost),
    sessions: sessionsArr.slice(0, 50),
    activeSessions,
    timeline: minuteBuckets,
  };
}

// Plan presets — these are approximations of Claude Code's 5-hour rolling
// session quotas, expressed as API-equivalent dollar budgets. Anthropic does
// not publish exact session limits; treat these as ballpark.
export const PLAN_PRESETS = {
  api: { name: 'api', label: 'API (pay-per-token)', budget: 0 },
  pro: { name: 'pro', label: 'Claude Pro ($20/mo)', budget: 10 },
  max5: { name: 'max5', label: 'Claude Max 5× ($100/mo)', budget: 50 },
  max20: { name: 'max20', label: 'Claude Max 20× ($200/mo)', budget: 200 },
};
const DEFAULT_PLAN = PLAN_PRESETS.api;

export function resolvePlan({ plan, budget } = {}) {
  let p;
  if (plan && PLAN_PRESETS[plan]) p = { ...PLAN_PRESETS[plan] };
  else p = { ...DEFAULT_PLAN };
  if (typeof budget === 'number' && budget >= 0) {
    p = { name: 'custom', label: `Custom budget ($${budget}/5h)`, budget };
  }
  return p;
}
