/**
 * anomaly.js
 * Uses Claude to decide whether a parsed timesheet is normal, suspicious, or rejected.
 *
 * Returns:
 * {
 *   decision: "approve" | "flag" | "reject",
 *   reason: string   — human-readable explanation sent back to the freelancer
 * }
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_HOURS = Number(process.env.MAX_HOURS_THRESHOLD ?? 60);
const RATE_DEV = Number(process.env.RATE_DEVIATION_THRESHOLD ?? 0.20);

const SYSTEM_PROMPT = `You are a payroll compliance engine for a freelancer payment platform.
You receive a JSON object with:
  - current: the timesheet being evaluated { freelancerName, hours, hourlyRate, projectName, totalUSD }
  - history: array of past approved timesheets for the same freelancer (may be empty)
  - thresholds: { maxHours, maxRateDeviationPct }

Evaluate the current timesheet and return ONLY a JSON object — no markdown, no explanation, no preamble:
{
  "decision": "approve" | "flag" | "reject",
  "reason": "<one or two sentences explaining the decision in plain English>"
}

Decision rules (apply in order):
1. REJECT if hours <= 0 or hourlyRate <= 0 (invalid data).
2. REJECT if walletAddress is missing or empty.
3. FLAG if hours > thresholds.maxHours.
4. FLAG if history has >= 2 entries AND the current hourlyRate deviates more than thresholds.maxRateDeviationPct from the average historical rate.
5. FLAG if totalUSD > 5000 (large payment — extra scrutiny).
6. APPROVE otherwise.

The reason must be actionable and professional.`;

/**
 * @param {object} timesheet   — output of parseTimesheet()
 * @param {object[]} history   — array of past approved timesheets for this freelancer
 * @returns {Promise<{ decision: string, reason: string }>}
 */
export async function checkAnomaly(timesheet, history = []) {
  const payload = {
    current: timesheet,
    history,
    thresholds: {
      maxHours: MAX_HOURS,
      maxRateDeviationPct: RATE_DEV,
    },
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
  });

  let raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error("[anomaly] Claude returned empty response");

  // Strip markdown code fences if present
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[anomaly] Claude response is not valid JSON: ${raw}`);
  }

  const decision = parsed.decision;
  if (!["approve", "flag", "reject"].includes(decision)) {
    throw new Error(`[anomaly] Unexpected decision value: "${decision}"`);
  }

  return {
    decision,
    reason: String(parsed.reason ?? ""),
  };
}
