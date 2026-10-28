# AGENTS.md — PayrollBot

AI payroll agent: Gmail timesheet/submission emails → Claude pipelines → SOL payment on Solana devnet, with a React dashboard.

## Commands
- Install: `npm install` (Node 18+, ESM — `"type": "module"`)
- Run everything: `npm run dev` (API :3001 + Vite :5173 via `concurrently`)
- Agent only: `npm run agent` · Dashboard only: `npm run frontend`
- Build dashboard: `npm run build`
- Print payer pubkey: `node get-pubkey.js`
- Tests / lint: none configured.
- Smoke test without Gmail: `POST http://localhost:3001/api/trigger` with `{subject, from, body}`.

## Where logic lives
- `src/agent/orchestrator.js` — entry point: all agents wired into two pipelines, Express routes, `sendEmail`, in-memory `transactions` / `paidThisWeek`.
- `src/agent/agentPipeline.js` — `Agent`, `Pipeline`, `AgentRouter`; an agent returns `{...ctx, halt: true}` to stop the pipeline.
- `src/agent/{parser,anomaly,qa,performanceEval,emailWriter,digest}.js` — one Claude call each, JSON-in-prompt outputs.
- `src/agent/approvalGate.js` — `requiresApproval(usd)` is `usd >= MAX_AUTO_PAYMENT_USD`; cancel-window timers.
- `src/solana/transfer.js` — devnet RPC hard-coded, `AGENT_FEE_PCT = 0.005`, 3 retries.
- `src/gmail/watcher.js` — Gmail REST poll; query `(subject:timesheet OR subject:submission) is:unread -subject:Re:`.
- `src/data/projects.json` — project DB keyed by project ID.

## Conventions
- Plain JS ESM, no TypeScript. Model id `claude-sonnet-4-6` is hard-coded in each agent file — change all together.
- Env read directly via `process.env` with inline defaults; keep README Configuration table in sync.
- Each agent logs its reasoning with `log(ctx, AgentName, status, message)`.

## Do not touch / commit
- `.env` (payer private key, Anthropic key, Gmail token).
- Solana keypair files (`id.json` is gitignored; other names are not).
- Don't point it at mainnet or real funds.

## Gotchas
- All state is in memory; restarting clears pending approvals and duplicate history.
- Gmail access tokens expire ~1 h. `GMAIL_MCP_URL` in `.env.example` is unused.
- Dashboard hard-codes `http://localhost:3001/api` (`src/frontend/App.jsx`).

Humans: see README.md
