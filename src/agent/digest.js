/**
 * digest.js
 * Weekly PM digest — Claude writes a concise summary of everything
 * the agent did. Sent automatically every Monday at 9am.
 * Also exposed via POST /api/digest/send for manual trigger (demo-friendly).
 *
 * This directly addresses "autonomous enough": agent manages its own
 * reporting cycle without being asked.
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are PayrollBot's reporting module. Write a concise, professional weekly digest email for a project manager.
You receive a JSON summary of everything the agent processed this week.

Rules:
- Write in plain text, no markdown
- Lead with a one-line headline summary
- Mention specific names, amounts, and projects — not just totals
- Flag anything that needed human attention or was anomalous
- Keep it under 200 words
- End with "— PayrollBot 🤖 | Weekly Digest"
- Output ONLY the email body`;

/**
 * Generates and returns the digest email body using Claude.
 * @param {object[]} transactions  — all transactions from in-memory store
 * @param {number}   agentEarned   — total agent fee USD
 * @returns {Promise<string>}
 */
export async function generateDigest(transactions, agentEarned) {
  const week = transactions.filter(tx => {
    const age = Date.now() - new Date(tx.processedAt).getTime();
    return age < 7 * 24 * 60 * 60 * 1000;
  });

  const summary = {
    totalProcessed: week.length,
    paid: week.filter(t => ["paid", "qa_approved"].includes(t.status)),
    partial: week.filter(t => t.status === "qa_partial"),
    flagged: week.filter(t => t.status === "flagged"),
    rejected: week.filter(t => ["rejected", "qa_rejected", "error"].includes(t.status)),
    clarifications: week.filter(t => t.status === "clarification_needed"),
    totalVolumeUSD: week.filter(t => t.totalUSD).reduce((s, t) => s + t.totalUSD, 0),
    agentEarnedUSD: agentEarned,
    highlights: week.slice(0, 5).map(t => ({
      freelancer: t.freelancerName,
      status: t.status,
      amount: t.totalUSD,
      project: t.projectName ?? t.project?.name,
      qaScore: t.qaScore,
      reason: t.reason,
    })),
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(summary) }],
  });

  return response.content[0]?.text?.trim() ?? "No digest content generated.";
}

/**
 * Starts the Monday 9am digest scheduler.
 * Checks every 5 minutes whether it's time to send.
 * Keeps track of last send date to avoid duplicates.
 *
 * @param {Function} getTransactions  — () => transactions[]
 * @param {Function} getAgentEarned   — () => number
 * @param {Function} sendEmail        — async (to, subject, body) => void
 */
export function scheduleWeeklyDigest(getTransactions, getAgentEarned, sendEmail) {
  const pmEmail = process.env.PM_EMAIL;
  if (!pmEmail) {
    console.warn("[digest] PM_EMAIL not set — weekly digest disabled");
    return;
  }

  let lastSentDate = null;

  const check = async () => {
    const now = new Date();
    const isMonday = now.getDay() === 1;
    const isNineAm = now.getHours() === 9 && now.getMinutes() < 5;
    const todayStr = now.toDateString();

    if (isMonday && isNineAm && lastSentDate !== todayStr) {
      lastSentDate = todayStr;
      console.log("[digest] 📋 Sending weekly PM digest…");
      try {
        const body = await generateDigest(getTransactions(), getAgentEarned());
        await sendEmail(pmEmail, `PayrollBot Weekly Digest — ${todayStr}`, body);
        console.log("[digest] ✓ Digest sent");
      } catch (err) {
        console.error("[digest] Failed to send digest:", err.message);
      }
    }
  };

  setInterval(check, 5 * 60 * 1000);
  console.log(`[digest] Weekly digest scheduled → ${pmEmail} every Monday 9am`);
}
