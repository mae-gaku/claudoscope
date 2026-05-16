#!/usr/bin/env node
import { createServer } from '../src/server.js';
import { DEFAULT_PROJECTS_DIR } from '../src/store.js';
import { exec } from 'node:child_process';
import os from 'node:os';

function parseArgs(argv) {
  const args = {
    port: 4317,
    host: '127.0.0.1',
    open: true,
    projectsDir: DEFAULT_PROJECTS_DIR,
    plan: 'api',
    budget: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = parseInt(argv[++i], 10);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--no-open') args.open = false;
    else if (a === '--projects-dir') args.projectsDir = argv[++i];
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--budget') args.budget = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      console.log('claudoscope 0.1.0');
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Claudoscope — real-time observability scope for Claude Code

Usage:
  claudoscope [options]

Options:
  -p, --port <port>          Port to listen on (default: 4317)
      --host <host>          Host to bind (default: 127.0.0.1)
      --no-open              Do not open browser automatically
      --projects-dir <path>  Override Claude projects dir (default: ~/.claude/projects)
      --plan <name>          Subscription plan for 5h session gauge:
                             api | pro | max5 | max20 (default: api)
      --budget <usd>         Custom 5h-window budget in USD (overrides --plan)
  -v, --version              Print version and exit
  -h, --help                 Print this help

Examples:
  claudoscope                    # Start dashboard on http://localhost:4317
  claudoscope -p 8080            # Use a different port
  claudoscope --plan max5        # Gauge against Claude Max 5× session budget
  claudoscope --budget 25        # Gauge against a custom $25 / 5h budget
`);
}

function openBrowser(url) {
  const platform = os.platform();
  let cmd;
  if (platform === 'darwin') cmd = `open "${url}"`;
  else if (platform === 'win32') cmd = `start "" "${url}"`;
  else {
    // Linux + WSL: try wslview, xdg-open, then fall back to printing the URL
    cmd = `(command -v wslview && wslview "${url}") || (command -v xdg-open && xdg-open "${url}") || true`;
  }
  exec(cmd, () => {});
}

async function main() {
  const args = parseArgs(process.argv);
  const server = await createServer({
    projectsDir: args.projectsDir,
    plan: args.plan,
    budget: args.budget,
  });
  server.listen(args.port, args.host, () => {
    const url = `http://${args.host}:${args.port}`;
    console.log(`\n  Claudoscope dashboard ready\n`);
    console.log(`    > Local:    ${url}`);
    console.log(`    > Watching: ${args.projectsDir}`);
    console.log(`    > Press Ctrl+C to stop\n`);
    if (args.open) openBrowser(url);
  });

  const shutdown = () => {
    console.log('\n[claudoscope] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[claudoscope] fatal:', err);
  process.exit(1);
});
