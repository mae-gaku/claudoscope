import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import { parseLine, readSessionFile, aggregate } from './parser.js';

export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Holds parsed events per session, watches for file changes, emits 'change' on update.
export class Store extends EventEmitter {
  constructor({ projectsDir = DEFAULT_PROJECTS_DIR, plan = null } = {}) {
    super();
    this.projectsDir = projectsDir;
    this.plan = plan;
    // sessionId -> { events: [], filePath, offset (bytes read), buffer (partial line) }
    this.sessions = new Map();
    this.watcher = null;
    this._dirty = false;
    this._flushTimer = null;
  }

  async start() {
    if (!fsSync.existsSync(this.projectsDir)) {
      console.warn(`[claudoscope] projects dir not found: ${this.projectsDir}`);
      await fs.mkdir(this.projectsDir, { recursive: true });
    }
    // Initial scan
    const projectDirs = await fs.readdir(this.projectsDir);
    for (const proj of projectDirs) {
      const projPath = path.join(this.projectsDir, proj);
      let stat;
      try {
        stat = await fs.stat(projPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let files;
      try {
        files = await fs.readdir(projPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        await this._ingestFile(path.join(projPath, f));
      }
    }

    // Watch for changes
    this.watcher = chokidar.watch(this.projectsDir, {
      ignored: (p) => p.endsWith('/memory') || /\/memory\//.test(p),
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignoreInitial: true,
    });
    this.watcher.on('add', (p) => this._onFileChange(p));
    this.watcher.on('change', (p) => this._onFileChange(p));
    this._scheduleFlush();
  }

  async stop() {
    if (this.watcher) await this.watcher.close();
    if (this._flushTimer) clearInterval(this._flushTimer);
  }

  async _onFileChange(filePath) {
    if (!filePath.endsWith('.jsonl')) return;
    await this._ingestFile(filePath);
    this._dirty = true;
  }

  async _ingestFile(filePath) {
    const sessionId = path.basename(filePath, '.jsonl');
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { events: [], filePath, offset: 0, buffer: '' };
      this.sessions.set(sessionId, entry);
    }
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return;
    }
    // File got smaller (deleted+rewritten) — reset
    if (stat.size < entry.offset) {
      entry.offset = 0;
      entry.buffer = '';
      entry.events = [];
    }
    if (stat.size === entry.offset) return;

    const fd = await fs.open(filePath, 'r');
    try {
      const length = stat.size - entry.offset;
      const buf = Buffer.alloc(length);
      await fd.read(buf, 0, length, entry.offset);
      entry.offset = stat.size;
      let chunk = entry.buffer + buf.toString('utf8');
      const lines = chunk.split('\n');
      entry.buffer = lines.pop() || '';
      const newEvents = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = parseLine(line, filePath);
        if (ev) {
          entry.events.push(ev);
          newEvents.push(ev);
        }
      }
      if (newEvents.length > 0) {
        this.emit('events', newEvents);
        this._dirty = true;
      }
    } finally {
      await fd.close();
    }
  }

  _scheduleFlush() {
    // Coalesce snapshot recomputes to at most once per second
    this._flushTimer = setInterval(() => {
      if (!this._dirty) return;
      this._dirty = false;
      this.emit('change', this.snapshot());
    }, 1000);
  }

  allEvents() {
    const all = [];
    for (const entry of this.sessions.values()) {
      for (const ev of entry.events) all.push(ev);
    }
    all.sort((a, b) => a.ts - b.ts);
    return all;
  }

  snapshot() {
    return aggregate(this.allEvents(), Date.now(), { plan: this.plan });
  }
}
