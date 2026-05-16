# Contributing to Claudoscope

Thanks for your interest in improving Claudoscope! It's a small, dependency-light project — please help keep it that way.

## Quick start

```bash
git clone https://github.com/<your-fork>/claudoscope.git
cd claudoscope
npm install
npm test            # node --test
npm run dev         # start with --no-open (won't pop a browser tab)
```

Requires **Node.js 18+**.

## Project layout

```
bin/claudoscope.js     CLI entry point (arg parsing, browser opening)
src/server.js          Tiny zero-framework HTTP server + SSE
src/store.js           File watcher + per-session event store
src/parser.js          JSONL → normalized event + dashboard aggregator
src/pricing.js         Hand-maintained model price table
src/claude_usage.js    Anthropic OAuth /usage poller
src/companion.js       Deterministic tamagotchi (no LLM calls)
public/                Vanilla JS dashboard (Chart.js from CDN)
test/                  node:test unit tests
```

## Principles

1. **Local-only.** No analytics, no telemetry, no phone-home. The only outbound HTTPS call is to `api.anthropic.com/api/oauth/usage` — exactly what Claude.ai itself does.
2. **Tiny runtime footprint.** `chokidar` is the only runtime dependency. New deps need a good reason.
3. **No build step.** The browser loads vanilla JS + Chart.js from a CDN. Keep it that way so `npx claudoscope` stays instant.
4. **Pricing table is hand-maintained.** When Anthropic changes pricing, edit `src/pricing.js` and the README's price table.
5. **Companion is zero-LLM.** Every nutrient must be derivable from JSONL events Claudoscope already parses. No LLM-call features in `src/companion.js` — that's the design.

## Submitting a PR

1. Fork & branch from `main`.
2. Run `npm test` and make sure everything passes.
3. Add a test if you're touching `parser.js`, `pricing.js`, or `companion.js`.
4. Keep commits focused. One logical change per PR.
5. Update the README if you add/change a flag or panel.

## Updating pricing

If Anthropic changes per-token pricing:

1. Edit `MODEL_PRICING` in `src/pricing.js`.
2. Update the price table in `README.md` to match.
3. Add a row to `test/pricing.test.js` if you added a new model family.

## Reporting bugs

Open an issue with:

- Node version (`node --version`)
- OS + shell (e.g. Windows + WSL Ubuntu 22.04 + bash)
- The exact command you ran
- What you expected vs what happened
- A snippet of relevant console output (redact paths/usernames if needed)

## License

By contributing, you agree your contributions will be licensed under the MIT License.
