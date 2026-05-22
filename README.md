# PayrollBot 🤖

> **Autonomous AI payroll agent** — reads freelancer emails, runs them through a multi-agent AI pipeline, and executes Solana payments automatically.  
> Built for the [Startit.rs Money Agent Hackathon](https://startit.rs).

[![Node.js](https://img.shields.io/badge/Node.js-ESM-green)](https://nodejs.org)
[![Claude](https://img.shields.io/badge/Claude-claude--sonnet--4--6-blueviolet)](https://anthropic.com)
[![Solana](https://img.shields.io/badge/Solana-devnet-9945FF)](https://solana.com)
[![React](https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB)](https://vitejs.dev)

---

## What it does

PayrollBot monitors a Gmail inbox and autonomously handles two types of freelancer payments:

| Email type | Trigger | What happens |
|---|---|---|
| **Timesheet** | Subject contains `timesheet` | Parses hours + rate → anomaly check → Solana payment |
| **Submission** | Subject contains `submission` | AI code review against requirements → partial/full payment |

Every decision is logged with full reasoning. Payments under the auto-limit get a cancel window; large payments require explicit PM approval.

---

## Architecture

```
Gmail inbox (polls every 15s)
        │
        ▼
  ┌─────────────┐
  │   Watcher   │  Gmail REST API — finds unread emails matching
  └──────┬──────┘  (subject:timesheet OR subject:submission) is:unread -subject:Re:
         │
         ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      AgentRouter                            │
  │                                                             │
  │   TIMESHEET PIPELINE          SUBMISSION PIPELINE           │
  │   ─────────────────           ──────────────────            │
  │   TimesheetParser             SubmissionParser              │
  │        ↓                           ↓                        │
  │   DuplicateGuard              ProjectLookup                 │
  │        ↓                           ↓                        │
  │   AnomalyDetector             QAReviewer                    │
  │        ↓                           ↓                        │
  │   PerformanceEval             PerformanceEval               │
  │        ↓                           ↓                        │
  │   ApprovalGate ←──────────────ApprovalGate                  │
  │        ↓                           ↓                        │
  │   Solana Transfer             Solana Transfer               │
  │        ↓                           ↓                        │
  │   ConfirmationWriter          SubmissionEmailWriter         │
  └─────────────────────────────────────────────────────────────┘
         │
         ▼
  React Dashboard (http://localhost:5173)
  Express API     (http://localhost:3001)
```

---

## Agent descriptions

### Timesheet pipeline

| Agent | Role |
|---|---|
| **TimesheetParser** | Claude extracts `freelancerName`, `hours`, `hourlyRate`, `walletAddress`, `projectName` from free-text email. Returns confidence score + missing fields. |
| **DuplicateGuard** | Blocks double-payment in the same week. If confidence < 50% or fields are missing, asks the freelancer to clarify. |
| **AnomalyDetector** | Claude compares timesheet against history. Flags if hours > 60/week, rate deviates > 20% from history, or total > $5,000. |
| **PerformanceEval** | Claude scans the email for performance signals (praise, scope creep, blockers). Applies a bonus (up to 1.2×) or penalty (down to 0.85×). |
| **ApprovalGate** | Payments < `MAX_AUTO_PAYMENT_USD` get a cancel window (opt-out). Larger payments require explicit PM approval (opt-in). |
| **Solana Transfer** | Fetches live SOL/USD price from CoinGecko, converts USD → SOL, sends via `@solana/web3.js`. Takes a 0.5% agent fee. |
| **ConfirmationWriter** | Claude writes a personalized confirmation email with the Solana explorer link. |

### Submission pipeline

| Agent | Role |
|---|---|
| **SubmissionParser** | Claude extracts `projectId`, `freelancerName`, `links`, and submission summary from the email. |
| **ProjectLookup** | Matches project ID to `src/data/projects.json`. If the project is unknown, asks for clarification. |
| **QAReviewer** | Claude checks each project requirement against the submission. Returns score (0–1), per-requirement pass/fail, and partial payment percentage. |
| **PerformanceEval** | Same as above — extra bonus for early delivery or exceptional quality. |
| **SubmissionPayment** | Pays `agreedBudget × partialPaymentPct`. Holds remainder until missing requirements are delivered. |
| **SubmissionEmailWriter** | Claude writes a detailed QA report email listing what passed, what failed, and the exact amount paid. |

---

## Quick start

### Prerequisites

- Node.js 18+
- A Solana devnet wallet (see below)
- Google OAuth2 token with Gmail scope

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/payrollbot.git
cd payrollbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...          # Anthropic API key
SOLANA_PRIVATE_KEY=your_base58_key    # Payer wallet private key
GMAIL_ACCESS_TOKEN=ya29...            # Gmail OAuth2 bearer token
```

### 3. Get a Solana devnet wallet

```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Generate a new wallet
solana-keygen new --outfile ~/.config/solana/id.json

# Get the public key
solana address

# Airdrop test SOL
solana airdrop 2 <YOUR_PUBKEY> --url devnet

# Export private key as base58 (for SOLANA_PRIVATE_KEY)
node --input-type=module -e "
import bs58 from 'bs58';
import fs from 'fs';
const key = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json'));
console.log(bs58.encode(Buffer.from(key)));
"
```

### 4. Get a Gmail OAuth2 token

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → Enable the Gmail API
3. Create OAuth 2.0 credentials (Desktop app type)
4. Use the OAuth Playground to get a token with scope `https://www.googleapis.com/auth/gmail.modify`
5. Paste the `access_token` value as `GMAIL_ACCESS_TOKEN` in your `.env`

> **Note:** OAuth tokens expire after ~1 hour. For longer runs, implement refresh token logic.

### 5. Add your projects (for submission pipeline)

Edit `src/data/projects.json` — add one entry per project:

```json
{
  "my-project": {
    "id": "my-project",
    "name": "My Project Name",
    "clientEmail": "client@example.com",
    "freelancerEmail": "dev@example.com",
    "freelancerName": "John Doe",
    "walletAddress": "DEVNET_WALLET_ADDRESS",
    "agreedBudget": 1000,
    "currency": "USD",
    "status": "active",
    "requirements": [
      "Requirement 1 — specific and verifiable",
      "Requirement 2 — specific and verifiable"
    ]
  }
}
```

### 6. Start

```bash
npm run dev
```

- **Dashboard** → http://localhost:5173
- **Agent API** → http://localhost:3001

---

## Testing with demo emails

Send an email **to the address whose Gmail token you configured**, with these subjects and bodies.

### Timesheet — auto-approved

**Subject:** `timesheet - Ana Petrovic`
```
Hi, I worked 23 hours this week on the website redesign project.
My rate is $45/hour.
My Solana wallet: <YOUR_DEVNET_WALLET>
Thanks, Ana
```

### Timesheet — flagged (too many hours)

**Subject:** `timesheet - Marko Jovanovic`
```
Hi, please process my timesheet. I worked 72 hours this week.
My rate is $55/hour. Wallet: <YOUR_DEVNET_WALLET>
```

### Submission — full pass

**Subject:** `submission - ecommerce-checkout`
```
Hi, I've completed the checkout redesign.

- Shopping cart uses localStorage — persists on reload ✓
- Stripe Elements integrated ✓
- Fully responsive (320px+) ✓
- Order confirmation email via SendGrid ✓
- Loading spinners on all async ops ✓
- Inline form validation ✓
- HTTPS enforced ✓

GitHub: https://github.com/you/project
Ana
```

### Manual trigger (no email needed)

```bash
curl -X POST http://localhost:3001/api/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "timesheet - Test Dev",
    "from": "test@example.com",
    "body": "Worked 20 hours on API project. Rate $50/hr. Wallet: <YOUR_DEVNET_WALLET>"
  }'
```

---

## Environment variables reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key |
| `SOLANA_PRIVATE_KEY` | ✅ | — | Base-58 private key of the payer wallet |
| `GMAIL_ACCESS_TOKEN` | ✅ | — | Gmail OAuth2 bearer token |
| `PM_EMAIL` | — | — | Email that receives approval requests and weekly digests |
| `MAX_AUTO_PAYMENT_USD` | — | `500` | Payments below this auto-execute (with cancel window). Above requires PM approval. |
| `CANCEL_WINDOW_MS` | — | `120000` | Milliseconds before auto-payment fires (default 2 min) |
| `POLL_INTERVAL_MS` | — | `30000` | Gmail poll interval in ms |
| `MAX_HOURS_THRESHOLD` | — | `60` | Hours/week above which a timesheet is flagged |
| `RATE_DEVIATION_THRESHOLD` | — | `0.20` | Rate deviation from history that triggers a flag (0.20 = 20%) |
| `AGENT_WALLET` | — | — | Public key of a separate wallet that collects the 0.5% agent fee |

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/transactions` | All processed payments (newest first) |
| `GET` | `/api/status` | Agent stats — total processed, approved, flagged, agent earnings |
| `GET` | `/api/projects` | Loaded project database |
| `GET` | `/api/pending` | Payments waiting for approval or in cancel window |
| `POST` | `/api/approve/:id` | Approve a held payment |
| `POST` | `/api/cancel/:id` | Cancel a payment in the cancel window |
| `POST` | `/api/trigger` | Manually inject an email for testing |
| `POST` | `/api/digest/send` | Send weekly PM digest immediately |

---

## Project structure

```
payrollbot/
├── src/
│   ├── agent/
│   │   ├── orchestrator.js      # Main entry: Express API + email handler + agent wiring
│   │   ├── agentPipeline.js     # Agent / Pipeline / AgentRouter primitives
│   │   ├── parser.js            # Claude: parse timesheet or submission from email
│   │   ├── anomaly.js           # Claude: anomaly detection on timesheet data
│   │   ├── qa.js                # Claude: QA review — checks submission vs requirements
│   │   ├── performanceEval.js   # Claude: detect performance signals, apply bonus/penalty
│   │   ├── emailWriter.js       # Claude: write reply emails for each scenario
│   │   ├── approvalGate.js      # Cancel window + PM approval logic
│   │   └── digest.js            # Claude: weekly PM digest writer
│   ├── gmail/
│   │   └── watcher.js           # Gmail REST API poller
│   ├── solana/
│   │   ├── transfer.js          # sendSOL(wallet, usdAmount) — Solana devnet
│   │   └── price.js             # CoinGecko SOL/USD price fetcher
│   ├── data/
│   │   └── projects.json        # Project database for submission pipeline
│   └── frontend/
│       ├── App.jsx              # React dashboard
│       └── main.jsx
├── .env.example
├── demo-emails.md               # Copy-paste test emails
├── package.json
└── vite.config.js
```

---

## How payments work

```
Freelancer sends email
        ↓
Agent processes & validates
        ↓
  ┌─────────────────────────┐
  │  Amount < $500?         │
  │  YES → Cancel window    │  PM gets notified, can cancel in dashboard
  │  NO  → PM approval      │  PM must explicitly approve in dashboard
  └─────────────────────────┘
        ↓ (if not cancelled/rejected)
SOL price fetched live from CoinGecko
        ↓
USD → SOL conversion
        ↓
Transaction sent on Solana devnet
        ↓
0.5% agent fee deducted → agent wallet
        ↓
Confirmation email sent to freelancer
```

---

## Human oversight

PayrollBot is designed with **human-in-the-loop** controls:

- **Anomaly detection** — flags unusual hours, rate spikes, or large amounts
- **Cancel window** — gives PM time to stop any auto-payment before it fires
- **Approval gate** — requires explicit PM approval for large payments
- **Decision log** — every agent records its reasoning; full audit trail in the dashboard
- **Duplicate guard** — prevents paying the same freelancer twice in a week
- **Weekly digest** — summarizes all activity and flags anything needing attention

---

## License

MIT
