/**
 * performanceEval.js
 * The most "impossible without AI" part of PayrollBot.
 *
 * Claude reads the freelancer's email for qualitative signals —
 * early delivery, going above scope, excuses, quality indicators —
 * and decides whether to adjust the payment up or down.
 *
 * No rule can evaluate: "delivered 2 days early and added dark mode
 * that wasn't in scope" → +8% bonus.
 * No rule can evaluate: "sorry it's a bit rough, ran out of time"
 * → -10% quality penalty.
 *
 * This is a real financial decision made from natural language.
 * That's load-bearing AI.
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a performance-based compensation engine.
You read a freelancer's email and their delivery history, then decide if their base payment should be adjusted.

You receive JSON:
{
  "emailBody": string,
  "basePayment": number,
  "history": array of past { totalUSD, qaScore, deliveredNote } entries (may be empty),
  "projectName": string,
  "freelancerName": string
}

Look for signals in the email text:
POSITIVE signals (justify bonus):
- Delivered early or ahead of schedule
- Went beyond scope (added features not required)
- Exceptional quality mentioned
- Strong QA history (average qaScore > 0.85)
- Long reliable track record

NEGATIVE signals (justify penalty):
- Apologetic language about quality ("rough", "ran out of time", "not fully tested")
- Missed requirements explicitly acknowledged
- Pattern of low QA scores in history

Return ONLY valid JSON — no markdown, no preamble:
{
  "multiplier": number between 0.85 and 1.15,
  "adjustedPayment": number,
  "reasoning": "one sentence explanation of the adjustment in plain English",
  "signals": ["list", "of", "signals", "detected"]
}

Rules:
- No adjustment (1.0) is the default — only adjust if there are clear signals
- Max bonus: +15% (multiplier 1.15)
- Max penalty: -15% (multiplier 0.85)
- Be conservative — err toward 1.0 if signals are weak
- reasoning must mention specific words/phrases from the email that drove the decision`;

/**
 * @param {string} emailBody
 * @param {number} basePayment
 * @param {object[]} history  — past transactions for this freelancer
 * @param {string} projectName
 * @param {string} freelancerName
 * @returns {Promise<{ multiplier, adjustedPayment, reasoning, signals }>}
 */
export async function evaluatePerformance(emailBody, basePayment, history = [], projectName = "", freelancerName = "") {
  const payload = {
    emailBody,
    basePayment,
    history: history.slice(-5).map(h => ({
      totalUSD: h.totalUSD,
      qaScore: h.qaScore ?? null,
      deliveredNote: h.rawNotes ?? "",
    })),
    projectName,
    freelancerName,
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  });

  let raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error("[perf] Claude returned empty response");

  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`[perf] Not valid JSON: ${raw}`); }

  const multiplier = Math.min(1.15, Math.max(0.85, Number(parsed.multiplier ?? 1.0)));
  const adjustedPayment = parseFloat((basePayment * multiplier).toFixed(2));

  return {
    multiplier,
    adjustedPayment,
    reasoning: String(parsed.reasoning ?? "No adjustment"),
    signals: Array.isArray(parsed.signals) ? parsed.signals : [],
  };
}
