// Fetches real-time session/quota utilization from Anthropic's OAuth usage endpoint.
// This is what Claude.ai and Claude Code's `/usage` slash command use under the hood —
// it returns the actual 5-hour rolling and 7-day usage percentages.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

async function readToken(credentialsPath) {
  try {
    const raw = await fs.readFile(credentialsPath, 'utf8');
    const obj = JSON.parse(raw);
    const oa = obj.claudeAiOauth || {};
    if (!oa.accessToken) return null;
    return {
      token: oa.accessToken,
      expiresAt: oa.expiresAt || 0,
      subscriptionType: oa.subscriptionType || null,
      rateLimitTier: oa.rateLimitTier || null,
    };
  } catch {
    return null;
  }
}

export async function fetchUsage(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  const creds = await readToken(credentialsPath);
  if (!creds) return { available: false, reason: 'no-credentials' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    return { available: false, reason: 'token-expired', subscriptionType: creds.subscriptionType };
  }
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'User-Agent': 'claudoscope/0.1',
      },
    });
  } catch (err) {
    return { available: false, reason: 'fetch-error', error: String(err) };
  }
  if (!res.ok) {
    return { available: false, reason: `http-${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { available: false, reason: 'parse-error', error: String(err) };
  }
  return {
    available: true,
    fetchedAt: Date.now(),
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
    fiveHour: body.five_hour || null,
    sevenDay: body.seven_day || null,
    sevenDayOpus: body.seven_day_opus || null,
    sevenDaySonnet: body.seven_day_sonnet || null,
    extraUsage: body.extra_usage || null,
  };
}

export async function fetchProfile(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  const creds = await readToken(credentialsPath);
  if (!creds) return null;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      displayName: body.account?.display_name || body.account?.full_name || null,
      email: body.account?.email || null,
      organizationType: body.organization?.organization_type || null,
      hasPro: !!body.account?.has_claude_pro,
      hasMax: !!body.account?.has_claude_max,
    };
  } catch {
    return null;
  }
}

// Poller — refetches usage at a fixed interval, emits 'usage' on update.
export class UsagePoller extends EventEmitter {
  constructor({ credentialsPath = DEFAULT_CREDENTIALS_PATH, intervalMs = 60_000 } = {}) {
    super();
    this.credentialsPath = credentialsPath;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.current = { available: false, reason: 'not-fetched-yet' };
  }

  async refresh() {
    const next = await fetchUsage(this.credentialsPath);
    this.current = next;
    this.emit('usage', next);
    return next;
  }

  start() {
    this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
