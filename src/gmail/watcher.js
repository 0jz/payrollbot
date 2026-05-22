/**
 * watcher.js
 * Polls Gmail directly via the Gmail REST API every POLL_INTERVAL_MS milliseconds.
 * Emits new "timesheet" and "submission" emails via a callback.
 * Never re-processes the same message ID.
 */

import axios from "axios";
import "dotenv/config";

const ACCESS_TOKEN = process.env.GMAIL_ACCESS_TOKEN ?? "";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const seen = new Set();

function headers() {
  return { Authorization: `Bearer ${ACCESS_TOKEN}` };
}

async function listMessages(query) {
  const { data } = await axios.get(`${BASE}/messages`, {
    headers: headers(),
    params: { q: query, maxResults: 20 },
    timeout: 15_000,
  });
  return data.messages ?? [];
}

async function getMessage(id) {
  const { data } = await axios.get(`${BASE}/messages/${id}`, {
    headers: headers(),
    params: { format: "full" },
    timeout: 15_000,
  });
  return data;
}

function getHeader(msg, name) {
  return msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value ?? "";
}

function decodeBody(msg) {
  // Try plain text part first, then fall back to snippet
  const parts = msg.payload?.parts ?? [];
  const plain = parts.find((p) => p.mimeType === "text/plain");
  if (plain?.body?.data) {
    return Buffer.from(plain.body.data, "base64").toString("utf-8");
  }
  if (msg.payload?.body?.data) {
    return Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
  }
  return msg.snippet ?? "";
}

async function markAsRead(id) {
  await axios.post(
    `${BASE}/messages/${id}/modify`,
    { removeLabelIds: ["UNREAD"] },
    { headers: headers(), timeout: 10_000 }
  ).catch(() => {}); // non-fatal
}

export function startWatcher(onEmail) {
  console.log(`[watcher] Starting Gmail poll every ${POLL_MS / 1000}s …`);

  async function poll() {
    try {
      // Search for both timesheet and submission emails
      const messages = await listMessages("(subject:timesheet OR subject:submission) is:unread -subject:Re:");
      console.log(`[watcher] found ${messages.length} new message(s)`);

      for (const { id } of messages) {
        if (seen.has(id)) continue;
        seen.add(id);

        const full = await getMessage(id);
        const subject = getHeader(full, "subject");
        const from    = getHeader(full, "from");
        const body    = decodeBody(full);
        const date    = getHeader(full, "date");

        console.log(`[watcher] 📬 New email: "${subject}" from ${from}`);

        await markAsRead(id);

        try {
          await onEmail({ id, subject, from, body, receivedAt: date });
        } catch (err) {
          console.error(`[watcher] Handler error for ${id}:`, err.message);
        }
      }
    } catch (err) {
      console.error("[watcher] Poll error:", err.message);
    }
  }

  poll();
  return setInterval(poll, POLL_MS);
}
