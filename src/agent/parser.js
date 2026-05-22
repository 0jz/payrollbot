/**
 * parser.js
 * Two responsibilities:
 *   1. Detect email type from subject: "timesheet" | "submission" | "unknown"
 *   2. Extract structured data from each type
 *
 * Timesheet → { freelancerName, hours, hourlyRate, projectName, walletAddress, totalUSD, confidence, missingFields }
 * Submission → { freelancerName, projectId, submissionText, links[], confidence, missingFields }
 */

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Email type detection ────────────────────────────────────────────────

/**
 * Determines the email type from the subject line.
 * Returns { type, projectId } where projectId is extracted from the subject.
 *
 * Subjects:
 *   "timesheet - ecommerce-checkout"  → { type: "timesheet", projectId: "ecommerce-checkout" }
 *   "submission - api-backend"        → { type: "submission", projectId: "api-backend" }
 */
export function detectEmailType(subject = "") {
  const lower = subject.toLowerCase().trim();

  const timesheetMatch = lower.match(/^timesheet[\s\-–]+(.+)$/);
  if (timesheetMatch) {
    return { type: "timesheet", projectId: timesheetMatch[1].trim() };
  }

  const submissionMatch = lower.match(/^submission[\s\-–]+(.+)$/);
  if (submissionMatch) {
    return { type: "submission", projectId: submissionMatch[1].trim() };
  }

  // Fallback: if subject just contains "timesheet" anywhere
  if (lower.includes("timesheet")) {
    return { type: "timesheet", projectId: null };
  }

  return { type: "unknown", projectId: null };
}

// ── Timesheet parser ────────────────────────────────────────────────────

const TIMESHEET_SYSTEM = `You are a payroll data extraction engine. Extract structured data from raw freelancer emails.
Return ONLY a valid JSON object — no markdown, no preamble:
{
  "freelancerName": string,
  "hours": number,
  "hourlyRate": number,
  "projectName": string,
  "walletAddress": string,
  "totalUSD": number,
  "confidence": number 0–1,
  "missingFields": string[],
  "rawNotes": string
}
Confidence: 1.0=all explicit, 0.8=minor inference, 0.6=one field inferred, 0.4=vague language, 0.2=critical fields missing.
Defaults: projectName="Unknown", walletAddress="", hours=0, hourlyRate=0. Compute totalUSD=hours*hourlyRate.`;

export async function parseTimesheet(emailBody, emailSubject = "") {
  const msg = emailSubject ? `Subject: ${emailSubject}\n\n${emailBody}` : emailBody;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: TIMESHEET_SYSTEM,
    messages: [{ role: "user", content: msg }],
  });

  let raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error("[parser] Claude returned empty response");

  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`[parser] Not valid JSON: ${raw}`); }

  return {
    freelancerName: String(parsed.freelancerName ?? "Unknown"),
    hours: Number(parsed.hours ?? 0),
    hourlyRate: Number(parsed.hourlyRate ?? 0),
    projectName: String(parsed.projectName ?? "Unknown"),
    walletAddress: String(parsed.walletAddress ?? ""),
    totalUSD: Number(parsed.totalUSD ?? 0),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
    missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields : [],
    rawNotes: String(parsed.rawNotes ?? ""),
  };
}

// ── Submission parser ───────────────────────────────────────────────────

const SUBMISSION_SYSTEM = `You are a project delivery coordinator. Extract structured data from a freelancer's work submission email.
Return ONLY a valid JSON object — no markdown, no preamble:
{
  "freelancerName": string,
  "projectId": string,
  "submissionText": string  (full cleaned description of what was built/delivered),
  "links": string[]         (all URLs mentioned — GitHub, demo, docs, etc.),
  "confidence": number 0–1  (how complete and clear the submission is),
  "missingFields": string[] (what's missing: e.g. "demo link", "test coverage report"),
  "rawNotes": string
}
The submissionText should preserve all technical details from the email — this will be used for QA review.`;

export async function parseSubmission(emailBody, emailSubject = "") {
  const msg = emailSubject ? `Subject: ${emailSubject}\n\n${emailBody}` : emailBody;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: SUBMISSION_SYSTEM,
    messages: [{ role: "user", content: msg }],
  });

  let raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error("[parser] Claude returned empty submission response");

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`[parser] Submission not valid JSON: ${raw}`); }

  return {
    freelancerName: String(parsed.freelancerName ?? "Unknown"),
    projectId: String(parsed.projectId ?? ""),
    submissionText: String(parsed.submissionText ?? emailBody),
    links: Array.isArray(parsed.links) ? parsed.links : [],
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
    missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields : [],
    rawNotes: String(parsed.rawNotes ?? ""),
  };
}
