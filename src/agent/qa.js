/**
 * qa.js
 * Autonomous QA agent — evaluates a freelancer's submission against
 * the project's defined requirements. Returns a detailed checklist,
 * score, and payment decision. No human reviewer needed.
 *
 * Returns:
 * {
 *   decision:          "approve" | "partial" | "reject",
 *   score:             number 0–1,
 *   partialPaymentPct: number 0–1  (1.0 if approve, 0 if reject),
 *   checklist: [
 *     { requirement: string, status: "pass"|"fail"|"partial", note: string }
 *   ],
 *   feedback:          string  — professional summary sent to freelancer
 *   criticalFailures:  string[]  — requirements that are blockers
 * }
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an autonomous QA engineer and technical project manager.
You evaluate freelancer work submissions against a project's defined requirements.

You receive a JSON object:
{
  "projectName": string,
  "requirements": string[],
  "submission": string   — the freelancer's description of what they built, links, notes
}

Evaluate each requirement based on the submission text. Be fair but strict.
If the freelancer mentions something that clearly satisfies a requirement, mark it pass.
If they don't mention it at all, mark it fail.
If they partially address it or it's unclear, mark it partial.

Return ONLY a valid JSON object — no markdown, no preamble:
{
  "decision": "approve" | "partial" | "reject",
  "score": number between 0 and 1,
  "partialPaymentPct": number between 0 and 1,
  "checklist": [
    { "requirement": string, "status": "pass" | "fail" | "partial", "note": string }
  ],
  "feedback": "2-4 sentence professional summary of the review",
  "criticalFailures": ["requirement text for any fail items"]
}

Decision rules:
- approve:  score >= 0.85  (at most 1 minor partial, no fails)
- partial:  score 0.5–0.84  → partialPaymentPct = score * 0.9
- reject:   score < 0.5 OR any requirement marked as critical fail in the checklist note

partialPaymentPct for approve = 1.0, for reject = 0.0.

Be constructive in notes — tell the freelancer exactly what's missing or wrong.`;

/**
 * @param {object} project   — from projects.json
 * @param {string} submission — freelancer's submission email body
 * @returns {Promise<QAResult>}
 */
export async function reviewSubmission(project, submission) {
  const payload = {
    projectName: project.name,
    requirements: project.requirements,
    submission,
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });

  let raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error("[qa] Claude returned empty response");

  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[qa] Claude response is not valid JSON: ${raw}`);
  }

  const decision = parsed.decision;
  if (!["approve", "partial", "reject"].includes(decision)) {
    throw new Error(`[qa] Unexpected decision: "${decision}"`);
  }

  return {
    decision,
    score: Math.min(1, Math.max(0, Number(parsed.score ?? 0))),
    partialPaymentPct: Math.min(1, Math.max(0, Number(parsed.partialPaymentPct ?? 0))),
    checklist: Array.isArray(parsed.checklist) ? parsed.checklist : [],
    feedback: String(parsed.feedback ?? ""),
    criticalFailures: Array.isArray(parsed.criticalFailures) ? parsed.criticalFailures : [],
  };
}
