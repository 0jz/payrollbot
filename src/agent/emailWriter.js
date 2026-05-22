/**
 * emailWriter.js
 * Claude writes every outbound email — no hardcoded templates.
 *
 * Scenarios:
 *   Timesheet:   approved | flagged | rejected | clarification
 *   Submission:  qa_approved | qa_partial | qa_rejected | qa_clarification
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are PayrollBot, an autonomous AI project delivery and payroll agent.
You write professional, warm, and specific emails to freelancers.
Rules:
- Sound human. Never say "I am an AI".
- Be specific — names, numbers, project details.
- Keep it under 150 words.
- For QA emails, always list specific checklist items with ✅ or ❌ or ⚠️.
- End every email with: — PayrollBot 🤖
- Output ONLY the email body, no subject, no JSON, no markdown.`;

export async function writeEmail(scenario, context) {
  const prompts = {
    // ── Timesheet scenarios ──────────────────────────────────
    approved: `Write a payment confirmation email.
Freelancer: ${context.freelancerName}, Project: ${context.projectName}
Hours: ${context.hours}h × $${context.hourlyRate} = $${Number(context.totalUSD).toFixed(2)}
SOL sent: ${context.solAmount?.toFixed(4)} SOL at $${context.solPrice}/SOL
Transaction: ${context.explorerUrl}
Tone: warm, celebratory but professional.`,

    flagged: `Write an email that the timesheet is flagged for human review.
Freelancer: ${context.freelancerName}, Project: ${context.projectName}
Flag reason: ${context.reason}
Tone: reassuring, routine check, no alarm.`,

    rejected: `Write a rejection email for a timesheet.
Freelancer: ${context.freelancerName}
Reason: ${context.reason}
Tone: apologetic, clear about what needs fixing.`,

    clarification: `Write an email asking for missing timesheet info.
Freelancer: ${context.freelancerName}
Missing: ${context.missingFields?.join(", ")}
Context: ${context.rawNotes}
Tone: friendly, specific about what's needed.`,

    // ── Submission / QA scenarios ────────────────────────────
    qa_approved: `Write a project delivery approval email with payment confirmation.
Freelancer: ${context.freelancerName}, Project: ${context.projectName}
QA Score: ${Math.round((context.score ?? 1) * 100)}%
Checklist results:
${context.checklist?.map(i => `${i.status === "pass" ? "✅" : i.status === "partial" ? "⚠️" : "❌"} ${i.requirement}: ${i.note}`).join("\n")}
Payment: $${Number(context.totalUSD).toFixed(2)} USD
Transaction: ${context.explorerUrl}
Tone: celebratory, acknowledge the quality of work.`,

    qa_partial: `Write an email for partial approval — some requirements passed, some failed.
Freelancer: ${context.freelancerName}, Project: ${context.projectName}
QA Score: ${Math.round((context.score ?? 0.7) * 100)}%
Checklist:
${context.checklist?.map(i => `${i.status === "pass" ? "✅" : i.status === "partial" ? "⚠️" : "❌"} ${i.requirement}: ${i.note}`).join("\n")}
Partial payment sent: $${Number(context.partialPayment).toFixed(2)} (${Math.round((context.partialPaymentPct ?? 0.7) * 100)}% of $${Number(context.totalUSD).toFixed(2)})
Transaction: ${context.explorerUrl}
Remaining: $${Number(context.remainingPayment).toFixed(2)} released when issues are fixed.
Critical failures to fix: ${context.criticalFailures?.join("; ")}
Tone: fair, constructive, make the path to full payment clear.`,

    qa_rejected: `Write a QA rejection email — work does not meet requirements.
Freelancer: ${context.freelancerName}, Project: ${context.projectName}
QA Score: ${Math.round((context.score ?? 0) * 100)}%
Failed requirements:
${context.criticalFailures?.map(r => `❌ ${r}`).join("\n")}
Tone: professional, not harsh — focus on what specifically needs to be redone.`,

    qa_clarification: `Write an email asking the freelancer to provide more detail about their submission.
Freelancer: ${context.freelancerName}, Project: ${context.projectName}
What's missing from submission: ${context.missingFields?.join(", ")}
Notes: ${context.rawNotes}
Tone: helpful, list exactly what links/info/evidence would make the review possible.`,
  };

  const userPrompt = prompts[scenario];
  if (!userPrompt) throw new Error(`[emailWriter] Unknown scenario: "${scenario}"`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const body = response.content[0]?.text?.trim();
  if (!body) throw new Error("[emailWriter] Claude returned empty body");
  return body;
}
