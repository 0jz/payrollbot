/**
 * approvalGate.js
 * Two-tier human oversight — directly addresses "give it your money":
 *
 * Tier 1 — Cancel window (all payments):
 *   Agent schedules payment, waits N minutes, executes unless cancelled.
 *   PM gets notified and can hit Cancel before money moves.
 *   Default: 2 minutes (fast enough for demo, real product: 10-15 min).
 *
 * Tier 2 — Explicit approval (large payments):
 *   Payments above MAX_AUTO_PAYMENT_USD are HELD until PM actively approves
 *   via dashboard button or reply email. Never auto-execute.
 *
 * This is the trust model: small amounts opt-out, large amounts opt-in.
 */

const CANCEL_WINDOW_MS = Number(process.env.CANCEL_WINDOW_MS ?? 2 * 60 * 1000); // 2 min default
const MAX_AUTO_USD = Number(process.env.MAX_AUTO_PAYMENT_USD ?? 500);

// { txId → { cancel(), expiresAt, ctx } }
const cancelWindows = new Map();

// { txId → { resolve(), reject(), ctx, requestedAt } }
const pendingApprovals = new Map();

// ── Tier 1: Cancel window ───────────────────────────────────────────────

/**
 * Schedules a payment with a cancel window.
 * Returns a promise that resolves when the window expires (payment goes through)
 * or rejects if cancelled.
 *
 * @param {string}   txId
 * @param {Function} executePayment  — async () => result
 * @returns {Promise}
 */
export function schedulePayment(txId, executePayment) {
  return new Promise((resolve, reject) => {
    const expiresAt = Date.now() + CANCEL_WINDOW_MS;

    const timer = setTimeout(async () => {
      cancelWindows.delete(txId);
      try {
        resolve(await executePayment());
      } catch (err) {
        reject(err);
      }
    }, CANCEL_WINDOW_MS);

    cancelWindows.set(txId, {
      cancel: (reason = "Cancelled by PM") => {
        clearTimeout(timer);
        cancelWindows.delete(txId);
        reject(new Error(reason));
      },
      expiresAt,
      txId,
    });
  });
}

// ── Tier 2: Explicit approval ───────────────────────────────────────────

/**
 * Holds a large payment until PM approves or 10-minute timeout.
 * @param {string} txId
 * @param {object} ctx — payment context for display
 * @returns {Promise<boolean>}
 */
export function requestApproval(txId, ctx) {
  return new Promise((resolve, reject) => {
    const APPROVAL_TIMEOUT = 10 * 60 * 1000;

    const timer = setTimeout(() => {
      pendingApprovals.delete(txId);
      reject(new Error(`Approval timeout — payment of $${ctx.totalUSD} auto-cancelled after 10 minutes`));
    }, APPROVAL_TIMEOUT);

    pendingApprovals.set(txId, {
      resolve: (v) => { clearTimeout(timer); pendingApprovals.delete(txId); resolve(v); },
      reject:  (e) => { clearTimeout(timer); pendingApprovals.delete(txId); reject(e); },
      ctx,
      requestedAt: new Date().toISOString(),
      expiresAt: Date.now() + APPROVAL_TIMEOUT,
    });
  });
}

export function approvePayment(txId) {
  const p = pendingApprovals.get(txId);
  if (!p) return false;
  p.resolve(true);
  return true;
}

export function cancelPayment(txId, reason) {
  // Check cancel windows first
  const cw = cancelWindows.get(txId);
  if (cw) { cw.cancel(reason); return true; }
  // Then pending approvals
  const pa = pendingApprovals.get(txId);
  if (pa) { pa.reject(new Error(reason ?? "Cancelled by PM")); return true; }
  return false;
}

// ── Thresholds + state accessors ───────────────────────────────────────

export const requiresApproval = (usdAmount) => usdAmount >= MAX_AUTO_USD;

export const getCancelWindowMs = () => CANCEL_WINDOW_MS;
export const getMaxAutoUSD = () => MAX_AUTO_USD;

export function getPendingApprovals() {
  return [...pendingApprovals.entries()].map(([id, p]) => ({
    id,
    ctx: p.ctx,
    requestedAt: p.requestedAt,
    expiresAt: p.expiresAt,
  }));
}

export function getCancelWindows() {
  return [...cancelWindows.entries()].map(([id, cw]) => ({
    id,
    expiresAt: cw.expiresAt,
  }));
}
