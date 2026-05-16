import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Store, DEFAULT_PROJECTS_DIR } from './store.js';
import { resolvePlan } from './parser.js';
import { UsagePoller } from './claude_usage.js';
import { CompanionStore } from './companion.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function createServer({
  projectsDir = DEFAULT_PROJECTS_DIR,
  plan = 'api',
  budget = null,
  usagePollMs = 60_000,
  credentialsPath,
} = {}) {
  const resolvedPlan = resolvePlan({ plan, budget });
  const store = new Store({ projectsDir, plan: resolvedPlan });
  await store.start();

  const usagePoller = new UsagePoller({ credentialsPath, intervalMs: usagePollMs });
  usagePoller.start();

  const companion = new CompanionStore();
  await companion.load();
  companion.start();

  const sseClients = new Set();

  usagePoller.on('usage', (usage) => {
    const payload = `event: usage\ndata: ${JSON.stringify(usage)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  });

  store.on('change', (snapshot) => {
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  store.on('events', (events) => {
    const payload = `event: events\ndata: ${JSON.stringify(events)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
    // Feed companion — deterministic, zero LLM calls.
    companion.applyEvents(events);
  });

  companion.on('change', (state) => {
    const payload = `event: companion\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  });

  // Seed the companion from history on first run so it isn't stuck at level 1
  // when claudoscope is launched on an existing Claude Code install.
  if ((companion.state.totals?.events || 0) === 0) {
    companion.applyEvents(store.allEvents());
  }

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    // CORS for local development convenience
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      if (pathname === '/api/snapshot') {
        const snap = store.snapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snap));
        return;
      }

      if (pathname === '/api/usage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(usagePoller.current || { available: false }));
        return;
      }

      if (pathname === '/api/companion' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(companion.state));
        return;
      }

      if (pathname === '/api/companion/pet' && req.method === 'POST') {
        const state = companion.pet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if (pathname === '/api/companion/rename' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const state = companion.rename(body?.name || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if (pathname === '/api/companion/reset' && req.method === 'POST') {
        const state = companion.reset();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if (pathname === '/api/events') {
        const limit = parseInt(parsed.query.limit, 10) || 200;
        const events = store.allEvents().slice(-limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
        return;
      }

      if (pathname === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            projectsDir,
            version: '0.1.0',
            startedAt: Date.now(),
            plan: resolvedPlan,
          })
        );
        return;
      }

      if (pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        // Send initial snapshot + usage + companion
        res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        if (usagePoller.current) {
          res.write(`event: usage\ndata: ${JSON.stringify(usagePoller.current)}\n\n`);
        }
        if (companion.state) {
          res.write(`event: companion\ndata: ${JSON.stringify(companion.state)}\n\n`);
        }
        sseClients.add(res);
        // Heartbeat every 25s
        const hb = setInterval(() => {
          try {
            res.write(`: heartbeat ${Date.now()}\n\n`);
          } catch {}
        }, 25000);
        req.on('close', () => {
          clearInterval(hb);
          sseClients.delete(res);
        });
        return;
      }

      // Static files
      await serveStatic(res, pathname);
    } catch (err) {
      console.error('[claudoscope] error', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  server.on('close', async () => {
    usagePoller.stop();
    companion.stop();
    try { await companion.save(); } catch {}
    await store.stop();
  });

  return server;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // Prevent path traversal
  rel = rel.replace(/\.\./g, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
