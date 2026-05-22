/**
 * orchestrator.js
 *
 * Every agent appends to ctx.decisionLog — a transparent record of every
 * decision made, with reasoning. This is what makes it "not just a wrapper":
 * the reasoning is visible, auditable, and generated under ambiguity.
 *
 * Payment flow:
 *   < MAX_AUTO_PAYMENT_USD  → 2-min cancel window (opt-out)
 *   ≥ MAX_AUTO_PAYMENT_USD  → held for explicit PM approval (opt-in)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import axios from "axios";

import { Agent, Pipeline, AgentRouter } from "./agentPipeline.js";
import { detectEmailType, parseTimesheet, parseSubmission } from "./parser.js";
import { checkAnomaly } from "./anomaly.js";
import { reviewSubmission } from "./qa.js";
import { evaluatePerformance } from "./performanceEval.js";
import { sendSOL } from "../solana/transfer.js";
import { writeEmail } from "./emailWriter.js";
import { startWatcher } from "../gmail/watcher.js";
import {
  schedulePayment, requestApproval,
  approvePayment, cancelPayment,
  requiresApproval, getCancelWindowMs, getMaxAutoUSD,
  getPendingApprovals, getCancelWindows,
} from "./approvalGate.js";
import { generateDigest, scheduleWeeklyDigest } from "./digest.js";

// ── Project DB ──────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_PATH = path.resolve(__dirname, "../data/projects.json");
const loadProjects = () => {
  try { return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8")); }
  catch { return {}; }
};

// ── In-memory store ─────────────────────────────────────────────────────
const transactions = [];
const history = {};
const paidThisWeek = {};
let agentTotalEarnedUSD = 0;

function getWeekKey(name) {
  const now = new Date();
  return `${name}_${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}`;
}

// ── Decision log helper ─────────────────────────────────────────────────
function log(ctx, agent, action, reasoning, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    agent,
    action,
    reasoning,
    ...data,
  };
  (ctx.decisionLog = ctx.decisionLog ?? []).push(entry);
  console.log(`  [${agent}] ${action}: ${reasoning}`);
  return entry;
}

// ── Gmail helper ────────────────────────────────────────────────────────
const ACCESS_TOKEN = process.env.GMAIL_ACCESS_TOKEN ?? "";

async function sendEmail(to, subject, body) {
  try {
    // Build RFC 2822 message and base64url-encode it
    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      body,
    ].join("\r\n");

    const encoded = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await axios.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { raw: encoded },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );
    console.log(`  [Email] ✓ Sent to ${to}`);
  } catch (err) {
    console.error(`  [Email] ✗ Failed to send to ${to}: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// TIMESHEET PIPELINE AGENTS
// ════════════════════════════════════════════════════════════════════════

const timesheetParserAgent = new Agent("TimesheetParser", async (ctx) => {
  const parsed = await parseTimesheet(ctx.email.body, ctx.email.subject);
  log(ctx, "TimesheetParser", "parsed",
    `Extracted ${parsed.hours}h @ $${parsed.hourlyRate}/h for ${parsed.freelancerName} (confidence ${Math.round(parsed.confidence * 100)}%)`,
    { confidence: parsed.confidence, missingFields: parsed.missingFields }
  );
  return { ...ctx, ...parsed, status: "parsed" };
});

const duplicateGuardAgent = new Agent("DuplicateGuard", async (ctx) => {
  const key = getWeekKey(ctx.freelancerName);

  if (paidThisWeek[key]) {
    log(ctx, "DuplicateGuard", "blocked",
      `${ctx.freelancerName} was already paid this week — duplicate rejected automatically`
    );
    const body = await writeEmail("rejected", { freelancerName: ctx.freelancerName, reason: "Already paid this week. If this is an error, reply directly." });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Duplicate`, body);
    return { ...ctx, status: "rejected", decision: "reject", reason: "Duplicate payment this week", halt: true };
  }

  if (ctx.confidence < 0.5 || ctx.missingFields.length > 0) {
    log(ctx, "DuplicateGuard", "clarification_needed",
      `Confidence ${Math.round(ctx.confidence * 100)}% below threshold. Missing: ${ctx.missingFields.join(", ") || "unclear data"}. Asking freelancer.`
    );
    const body = await writeEmail("clarification", { freelancerName: ctx.freelancerName, missingFields: ctx.missingFields, rawNotes: ctx.rawNotes });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Quick question`, body);
    return { ...ctx, status: "clarification_needed", decision: "clarify", halt: true };
  }

  log(ctx, "DuplicateGuard", "passed", `No duplicate found for ${ctx.freelancerName} this week`);
  return ctx;
});

const anomalyAgent = new Agent("AnomalyDetector", async (ctx) => {
  const { decision, reason } = await checkAnomaly(ctx, history[ctx.freelancerName] ?? []);
  log(ctx, "AnomalyDetector", decision,
    reason,
    { hours: ctx.hours, hourlyRate: ctx.hourlyRate, historyLength: (history[ctx.freelancerName] ?? []).length }
  );
  return { ...ctx, decision, reason };
});

const timesheetPaymentAgent = new Agent("TimesheetPayment", async (ctx) => {
  if (ctx.decision === "flag") {
    log(ctx, "TimesheetPayment", "flagged", `Payment held for human review: ${ctx.reason}`);
    const body = await writeEmail("flagged", { freelancerName: ctx.freelancerName, projectName: ctx.projectName, reason: ctx.reason });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Under Review`, body);
    return { ...ctx, status: "flagged", halt: true };
  }
  if (ctx.decision === "reject") {
    log(ctx, "TimesheetPayment", "rejected", ctx.reason);
    const body = await writeEmail("rejected", { freelancerName: ctx.freelancerName, reason: ctx.reason });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Rejected`, body);
    return { ...ctx, status: "rejected", halt: true };
  }

  // ── Performance evaluation ───────────────────────────────────
  try {
    const perf = await evaluatePerformance(
      ctx.email.body, ctx.totalUSD,
      history[ctx.freelancerName] ?? [],
      ctx.projectName, ctx.freelancerName
    );
    if (perf.multiplier !== 1.0) {
      log(ctx, "PerformanceEval", perf.multiplier > 1 ? "bonus" : "penalty",
        perf.reasoning,
        { multiplier: perf.multiplier, signals: perf.signals, originalUSD: ctx.totalUSD }
      );
      ctx = { ...ctx, totalUSD: perf.adjustedPayment, performanceMultiplier: perf.multiplier, performanceReasoning: perf.reasoning };
    } else {
      log(ctx, "PerformanceEval", "no_adjustment", "No strong performance signals detected — base rate applied");
    }
  } catch (err) {
    console.warn("[PerformanceEval] Skipped:", err.message);
  }

  // ── Approval gate ────────────────────────────────────────────
  const needsApproval = requiresApproval(ctx.totalUSD);

  if (needsApproval) {
    log(ctx, "TimesheetPayment", "approval_required",
      `$${ctx.totalUSD} exceeds auto-approve limit of $${getMaxAutoUSD()}. Holding for PM approval.`
    );
    Object.assign(ctx, { status: "pending_approval" });

    const pmEmail = process.env.PM_EMAIL;
    if (pmEmail) {
      await sendEmail(pmEmail, `[PayrollBot] Approval needed — $${ctx.totalUSD} for ${ctx.freelancerName}`,
        `A payment requires your approval:\n\nFreelancer: ${ctx.freelancerName}\nProject: ${ctx.projectName}\nHours: ${ctx.hours}h × $${ctx.hourlyRate}/h = $${ctx.totalUSD}\n\nApprove or cancel in the PayrollBot dashboard.\n\n— PayrollBot 🤖`
      );
    }

    try {
      await requestApproval(ctx.id, ctx);
      log(ctx, "TimesheetPayment", "approved", "PM approved the payment via dashboard");
    } catch (err) {
      log(ctx, "TimesheetPayment", "approval_cancelled", err.message);
      const body = await writeEmail("rejected", { freelancerName: ctx.freelancerName, reason: "Payment was not approved within the required window." });
      await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Payment Cancelled`, body);
      return { ...ctx, status: "cancelled", halt: true };
    }
  } else {
    // ── Cancel window ────────────────────────────────────────────
    const windowMin = Math.round(getCancelWindowMs() / 60000);
    log(ctx, "TimesheetPayment", "cancel_window_open",
      `$${ctx.totalUSD} is within auto-approve limit. ${windowMin}-minute cancel window started.`
    );
    Object.assign(ctx, { status: "pending_cancel_window", cancelExpiresAt: Date.now() + getCancelWindowMs() });

    const pmEmail = process.env.PM_EMAIL;
    if (pmEmail) {
      await sendEmail(pmEmail,
        `[PayrollBot] Payment in ${windowMin}min — $${ctx.totalUSD} for ${ctx.freelancerName}`,
        `Auto-payment scheduled:\n\nFreelancer: ${ctx.freelancerName}\nAmount: $${ctx.totalUSD}\n\nCancel in the dashboard within ${windowMin} minutes if needed.\n\n— PayrollBot 🤖`
      );
    }

    try {
      const result = await schedulePayment(ctx.id, () => sendSOL(ctx.walletAddress, ctx.totalUSD));
      paidThisWeek[getWeekKey(ctx.freelancerName)] = true;
      agentTotalEarnedUSD += result.agentFeeUSD ?? 0;
      if (!history[ctx.freelancerName]) history[ctx.freelancerName] = [];
      history[ctx.freelancerName].push({ hours: ctx.hours, hourlyRate: ctx.hourlyRate, totalUSD: ctx.totalUSD });
      log(ctx, "TimesheetPayment", "paid", `Transfer confirmed on Solana devnet. Sig: ${result.signature?.slice(0, 16)}…`, { explorerUrl: result.explorerUrl });
      return { ...ctx, status: "paid", ...result };
    } catch (err) {
      log(ctx, "TimesheetPayment", "cancelled_or_failed", err.message);
      if (err.message.startsWith("Cancelled")) {
        const body = await writeEmail("rejected", { freelancerName: ctx.freelancerName, reason: "Payment was cancelled during the review window." });
        await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Payment Cancelled`, body);
        return { ...ctx, status: "cancelled", halt: true };
      }
      return { ...ctx, status: "error", reason: err.message, halt: true };
    }
  }

  // Reached here only after explicit approval
  try {
    const result = await sendSOL(ctx.walletAddress, ctx.totalUSD);
    paidThisWeek[getWeekKey(ctx.freelancerName)] = true;
    agentTotalEarnedUSD += result.agentFeeUSD ?? 0;
    if (!history[ctx.freelancerName]) history[ctx.freelancerName] = [];
    history[ctx.freelancerName].push({ hours: ctx.hours, hourlyRate: ctx.hourlyRate, totalUSD: ctx.totalUSD });
    log(ctx, "TimesheetPayment", "paid", `Transfer confirmed after PM approval. Sig: ${result.signature?.slice(0, 16)}…`);
    return { ...ctx, status: "paid", ...result };
  } catch (err) {
    log(ctx, "TimesheetPayment", "transfer_failed", err.message);
    return { ...ctx, status: "error", reason: err.message, halt: true };
  }
});

const timesheetEmailAgent = new Agent("ConfirmationWriter", async (ctx) => {
  const body = await writeEmail("approved", {
    freelancerName: ctx.freelancerName, projectName: ctx.projectName,
    hours: ctx.hours, hourlyRate: ctx.hourlyRate, totalUSD: ctx.totalUSD,
    solAmount: ctx.solAmount, solPrice: ctx.solPrice, explorerUrl: ctx.explorerUrl,
  });
  await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Payment Sent ✅`, body);
  log(ctx, "ConfirmationWriter", "email_sent", "Claude-generated confirmation email sent to freelancer");
  return ctx;
});

// ════════════════════════════════════════════════════════════════════════
// SUBMISSION PIPELINE AGENTS
// ════════════════════════════════════════════════════════════════════════

const submissionParserAgent = new Agent("SubmissionParser", async (ctx) => {
  const parsed = await parseSubmission(ctx.email.body, ctx.email.subject);
  log(ctx, "SubmissionParser", "parsed",
    `Submission from ${parsed.freelancerName} for project "${parsed.projectId}". ${parsed.links.length} link(s) found. Confidence: ${Math.round(parsed.confidence * 100)}%`,
    { confidence: parsed.confidence, links: parsed.links }
  );
  return { ...ctx, ...parsed, status: "parsed" };
});

const projectLookupAgent = new Agent("ProjectLookup", async (ctx) => {
  const projects = loadProjects();
  const pid = ctx.projectId || ctx.emailProjectId;
  const project = projects[pid] ?? Object.values(projects).find(
    p => p.name.toLowerCase().includes((pid ?? "").toLowerCase())
  );

  if (!project) {
    log(ctx, "ProjectLookup", "not_found", `Project "${pid}" not in database. Known: ${Object.keys(projects).join(", ")}`);
    const body = await writeEmail("qa_clarification", {
      freelancerName: ctx.freelancerName, projectName: pid,
      missingFields: ["project not found"], rawNotes: `Known: ${Object.keys(projects).join(", ")}`,
    });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — Project Not Found`, body);
    return { ...ctx, status: "rejected", reason: "Project not found", halt: true };
  }

  if (ctx.confidence < 0.5 || ctx.missingFields.length > 0) {
    log(ctx, "ProjectLookup", "clarification_needed",
      `Submission too vague to QA (confidence ${Math.round(ctx.confidence * 100)}%). Missing: ${ctx.missingFields.join(", ")}`
    );
    const body = await writeEmail("qa_clarification", {
      freelancerName: ctx.freelancerName, projectName: project.name,
      missingFields: ctx.missingFields, rawNotes: ctx.rawNotes,
    });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — More detail needed`, body);
    return { ...ctx, status: "clarification_needed", halt: true };
  }

  log(ctx, "ProjectLookup", "found", `Matched project "${project.name}" with ${project.requirements.length} requirements`);
  return { ...ctx, project, status: "project_found" };
});

const qaAgentStep = new Agent("QAReviewer", async (ctx) => {
  const qaResult = await reviewSubmission(ctx.project, ctx.submissionText);
  const passed = qaResult.checklist.filter(c => c.status === "pass").length;
  const total = qaResult.checklist.length;
  log(ctx, "QAReviewer", `qa_${qaResult.decision}`,
    `${passed}/${total} requirements met (score ${Math.round(qaResult.score * 100)}%). ${qaResult.feedback}`,
    { score: qaResult.score, criticalFailures: qaResult.criticalFailures }
  );
  return { ...ctx, qaResult, status: `qa_${qaResult.decision}` };
});

const submissionPaymentAgent = new Agent("SubmissionPayment", async (ctx) => {
  const { qaResult, project } = ctx;

  if (qaResult.decision === "reject") {
    log(ctx, "SubmissionPayment", "rejected", `QA score ${Math.round(qaResult.score * 100)}% — below threshold. No payment.`);
    const body = await writeEmail("qa_rejected", {
      freelancerName: ctx.freelancerName, projectName: project.name,
      score: qaResult.score, criticalFailures: qaResult.criticalFailures, checklist: qaResult.checklist,
    });
    await sendEmail(ctx.email.from, `Re: ${ctx.email.subject} — QA Failed`, body);
    return { ...ctx, status: "qa_rejected", totalUSD: 0, halt: true };
  }

  let paymentUSD = project.agreedBudget * qaResult.partialPaymentPct;

  // Performance eval on top of QA score
  try {
    const perf = await evaluatePerformance(
      ctx.submissionText, paymentUSD,
      history[ctx.freelancerName] ?? [],
      project.name, ctx.freelancerName
    );
    if (perf.multiplier !== 1.0) {
      log(ctx, "PerformanceEval", perf.multiplier > 1 ? "bonus" : "penalty",
        perf.reasoning,
        { multiplier: perf.multiplier, signals: perf.signals, originalUSD: paymentUSD }
      );
      ctx = { ...ctx, performanceMultiplier: perf.multiplier, performanceReasoning: perf.reasoning };
      paymentUSD = perf.adjustedPayment;
    } else {
      log(ctx, "PerformanceEval", "no_adjustment", "No strong signals — QA-based payment applied as-is");
    }
  } catch (err) {
    console.warn("[PerformanceEval] Skipped:", err.message);
  }

  const remainingUSD = project.agreedBudget - paymentUSD;
  const needsApproval = requiresApproval(paymentUSD);

  log(ctx, "SubmissionPayment", needsApproval ? "approval_required" : "cancel_window_open",
    `Paying $${paymentUSD.toFixed(2)} (${Math.round(qaResult.partialPaymentPct * 100)}% of $${project.agreedBudget} budget). ${needsApproval ? "Above auto-limit — needs PM approval." : "Within auto-limit — cancel window started."}`
  );

  Object.assign(ctx, { totalUSD: paymentUSD, remainingPayment: remainingUSD, partialPaymentPct: qaResult.partialPaymentPct });

  if (needsApproval) {
    Object.assign(ctx, { status: "pending_approval" });
    const pmEmail = process.env.PM_EMAIL;
    if (pmEmail) {
      await sendEmail(pmEmail, `[PayrollBot] QA payment approval — $${paymentUSD.toFixed(2)} for ${ctx.freelancerName}`,
        `Project: ${project.name}\nQA Score: ${Math.round(qaResult.score * 100)}%\nPayment: $${paymentUSD.toFixed(2)}\n\nApprove in the PayrollBot dashboard.\n\n— PayrollBot 🤖`
      );
    }
    try {
      await requestApproval(ctx.id, ctx);
    } catch (err) {
      log(ctx, "SubmissionPayment", "cancelled", err.message);
      return { ...ctx, status: "cancelled", halt: true };
    }
  }

  try {
    const doPayment = () => sendSOL(project.walletAddress, paymentUSD);
    const result = needsApproval
      ? await doPayment()
      : await schedulePayment(ctx.id, doPayment);

    agentTotalEarnedUSD += result.agentFeeUSD ?? 0;
    log(ctx, "SubmissionPayment", "paid", `$${paymentUSD.toFixed(2)} transferred. ${remainingUSD > 0 ? `$${remainingUSD.toFixed(2)} held pending fixes.` : "Full budget paid."}`);
    return { ...ctx, status: qaResult.decision === "approve" ? "qa_approved" : "qa_partial", ...result };
  } catch (err) {
    if (err.message.startsWith("Cancelled")) {
      log(ctx, "SubmissionPayment", "cancelled", err.message);
      return { ...ctx, status: "cancelled", halt: true };
    }
    log(ctx, "SubmissionPayment", "error", err.message);
    return { ...ctx, status: "error", reason: err.message, halt: true };
  }
});

const submissionEmailAgent = new Agent("SubmissionEmailWriter", async (ctx) => {
  const scenario = ctx.qaResult.decision === "approve" ? "qa_approved" : "qa_partial";
  const body = await writeEmail(scenario, {
    freelancerName: ctx.freelancerName, projectName: ctx.project.name,
    score: ctx.qaResult.score, checklist: ctx.qaResult.checklist,
    criticalFailures: ctx.qaResult.criticalFailures,
    totalUSD: ctx.totalUSD, remainingPayment: ctx.remainingPayment,
    partialPaymentPct: ctx.partialPaymentPct,
    solAmount: ctx.solAmount, solPrice: ctx.solPrice, explorerUrl: ctx.explorerUrl,
  });
  const subj = ctx.qaResult.decision === "approve"
    ? `Re: ${ctx.email.subject} — Delivered & Paid ✅`
    : `Re: ${ctx.email.subject} — Partial Payment Sent ⚠️`;
  await sendEmail(ctx.email.from, subj, body);
  log(ctx, "SubmissionEmailWriter", "email_sent", "Claude-written QA result email sent to freelancer");
  return ctx;
});

// ════════════════════════════════════════════════════════════════════════
// PIPELINES & ROUTER
// ════════════════════════════════════════════════════════════════════════

const router = new AgentRouter()
  .register("timesheet", new Pipeline("Timesheet", [
    timesheetParserAgent, duplicateGuardAgent, anomalyAgent,
    timesheetPaymentAgent, timesheetEmailAgent,
  ]))
  .register("submission", new Pipeline("Submission", [
    submissionParserAgent, projectLookupAgent, qaAgentStep,
    submissionPaymentAgent, submissionEmailAgent,
  ]));

// ════════════════════════════════════════════════════════════════════════
// MAIN EMAIL HANDLER
// ════════════════════════════════════════════════════════════════════════

async function processEmail(email) {
  const { type: emailType, projectId: emailProjectId } = detectEmailType(email.subject);

  const record = {
    id: email.id,
    emailFrom: email.from, subject: email.subject,
    receivedAt: email.receivedAt, processedAt: new Date().toISOString(),
    emailType, status: "processing",
    decisionLog: [],
    freelancerName: null, hours: null, hourlyRate: null,
    totalUSD: null, projectName: null, walletAddress: null,
    decision: null, reason: null, confidence: null, missingFields: [],
    agentFeeUSD: 0, signature: null, explorerUrl: null,
    qaScore: null, qaChecklist: null, partialPaymentPct: null, remainingPayment: null,
    cancelExpiresAt: null,
  };
  transactions.push(record);

  try {
    const result = await router.route({ email, emailType, emailProjectId, ...record });
    Object.assign(record, result);
    if (result.qaResult) {
      record.qaScore = result.qaResult.score;
      record.qaChecklist = result.qaResult.checklist;
    }
    record.agentFeeUSD = result.agentFeeUSD ?? 0;
    record.decisionLog = result.decisionLog ?? [];
  } catch (err) {
    console.error("[orchestrator] Error:", err.message);
    record.status = "error";
    record.reason = err.message;
  }
}

// ════════════════════════════════════════════════════════════════════════
// EXPRESS API
// ════════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/transactions", (_req, res) => res.json([...transactions].reverse()));

app.get("/api/status", (_req, res) => res.json({
  running: true,
  totalProcessed: transactions.length,
  approved: transactions.filter(t => ["paid", "qa_approved"].includes(t.status)).length,
  flagged: transactions.filter(t => ["flagged", "qa_partial"].includes(t.status)).length,
  rejected: transactions.filter(t => ["rejected", "qa_rejected", "cancelled", "error"].includes(t.status)).length,
  agentTotalEarnedUSD: parseFloat(agentTotalEarnedUSD.toFixed(4)),
  totalVolumeUSD: transactions.filter(t => t.totalUSD).reduce((s, t) => s + t.totalUSD, 0),
  maxAutoUSD: getMaxAutoUSD(),
  cancelWindowMs: getCancelWindowMs(),
}));

app.get("/api/projects", (_req, res) => res.json(loadProjects()));

app.get("/api/pending", (_req, res) => res.json({
  approvals: getPendingApprovals(),
  cancelWindows: getCancelWindows(),
}));

app.post("/api/approve/:id", (req, res) => {
  const ok = approvePayment(req.params.id);
  res.json({ ok, message: ok ? "Payment approved" : "No pending approval found" });
});

app.post("/api/cancel/:id", (req, res) => {
  const ok = cancelPayment(req.params.id, "Cancelled by PM via dashboard");
  res.json({ ok, message: ok ? "Payment cancelled" : "No cancellable payment found" });
});

// Manual trigger — for demo and testing without Gmail MCP
app.post("/api/trigger", async (req, res) => {
  const { subject, from, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: "subject and body required" });
  const email = {
    id: `manual-${Date.now()}`,
    subject, from: from || "demo@payrollbot.ai",
    body, receivedAt: new Date().toISOString(),
  };
  res.json({ ok: true, id: email.id });
  processEmail(email); // fire and forget
});

app.post("/api/digest/send", async (_req, res) => {
  try {
    const body = await generateDigest(transactions, agentTotalEarnedUSD);
    const pmEmail = process.env.PM_EMAIL;
    if (pmEmail) await sendEmail(pmEmail, `PayrollBot Digest — ${new Date().toDateString()}`, body);
    res.json({ ok: true, body });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(3001, () => console.log("[orchestrator] API → http://localhost:3001"));

// ── Weekly digest scheduler ─────────────────────────────────────────────
scheduleWeeklyDigest(() => transactions, () => agentTotalEarnedUSD, sendEmail);

// ── Gmail watcher ───────────────────────────────────────────────────────
startWatcher(processEmail);

console.log(`[orchestrator] 🤖 PayrollBot running
  → Auto-approve limit: $${getMaxAutoUSD()}
  → Cancel window: ${getCancelWindowMs() / 1000}s
  → Timesheet + Submission pipelines active`);
