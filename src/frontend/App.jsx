import { useState, useEffect, useCallback, useRef } from "react";

const API = "http://localhost:3001/api";
const POLL_MS = 2500;

const STATUS_META = {
  processing:             { color: "#6366f1", label: "Processing",          dot: "⚙️"  },
  parsed:                 { color: "#6366f1", label: "Parsed",              dot: "📄" },
  pending_cancel_window:  { color: "#f59e0b", label: "Cancel Window Open",  dot: "⏳" },
  pending_approval:       { color: "#f97316", label: "Awaiting Approval",   dot: "🔐" },
  transferring:           { color: "#f59e0b", label: "Transferring",        dot: "💸" },
  paid:                   { color: "#10b981", label: "Paid",                dot: "✅" },
  qa_approved:            { color: "#10b981", label: "QA Approved",         dot: "✅" },
  qa_partial:             { color: "#f59e0b", label: "Partial Payment",     dot: "⚠️" },
  qa_rejected:            { color: "#ef4444", label: "QA Failed",           dot: "❌" },
  flagged:                { color: "#f97316", label: "Flagged",             dot: "🚩" },
  rejected:               { color: "#ef4444", label: "Rejected",            dot: "❌" },
  cancelled:              { color: "#6b7280", label: "Cancelled",           dot: "🚫" },
  clarification_needed:   { color: "#8b5cf6", label: "Needs Clarification", dot: "❓" },
  error:                  { color: "#ef4444", label: "Error",               dot: "💥" },
};

const ACTION_COLOR = {
  approved: "#10b981", paid: "#10b981", qa_approved: "#10b981", found: "#10b981",
  flagged: "#f97316", qa_partial: "#f97316", cancel_window_open: "#f59e0b",
  approval_required: "#f97316", pending_approval: "#f97316",
  rejected: "#ef4444", qa_rejected: "#ef4444", blocked: "#ef4444",
  clarification_needed: "#8b5cf6", not_found: "#ef4444",
  parsed: "#818cf8", clarification_needed_step: "#8b5cf6",
  cancelled: "#6b7280", cancelled_or_failed: "#6b7280",
  email_sent: "#475569", passed: "#10b981",
};

const QA_ICON = { pass: "✅", partial: "⚠️", fail: "❌" };
const CC = (c) => c >= 0.85 ? "#10b981" : c >= 0.5 ? "#f59e0b" : "#ef4444";

// ── Small components ────────────────────────────────────────────────────

function Badge({ label, color, small }) {
  return (
    <span style={{
      background: color + "22", color, border: `1px solid ${color}55`,
      borderRadius: 6, padding: small ? "1px 7px" : "2px 10px",
      fontSize: small ? 10 : 12, fontWeight: 700, letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: "#1e1e2e", border: "1px solid #2a2a3e", borderRadius: 12, padding: "14px 18px", flex: 1, minWidth: 100 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: color + "99", marginTop: 1 }}>{sub}</div>}
      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

function ScoreBar({ score }) {
  const pct = Math.round((score ?? 0) * 100);
  const color = CC(score ?? 0);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, background: "#2a2a3e", borderRadius: 999, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 999, transition: "width 0.5s" }} />
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 700, minWidth: 34 }}>{pct}%</span>
    </div>
  );
}

function Countdown({ expiresAt }) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setRemaining(r => Math.max(0, r - 1000)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  const s = Math.floor(remaining / 1000);
  const m = Math.floor(s / 60);
  const color = s < 30 ? "#ef4444" : s < 60 ? "#f59e0b" : "#f97316";
  return <span style={{ color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{m}:{String(s % 60).padStart(2, "0")}</span>;
}

function DecisionLog({ log }) {
  if (!log?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Decision Log</div>
      {log.map((entry, i) => {
        const color = ACTION_COLOR[entry.action] ?? "#64748b";
        return (
          <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8, fontSize: 11 }}>
            <div style={{ flexShrink: 0, paddingTop: 2 }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: color, marginTop: 2 }} />
            </div>
            <div>
              <span style={{ color, fontWeight: 700, textTransform: "uppercase", fontSize: 10, letterSpacing: 0.5 }}>{entry.agent}</span>
              <span style={{ color: "#475569", margin: "0 5px" }}>·</span>
              <span style={{ color: "#94a3b8" }}>{entry.reasoning}</span>
              <span style={{ color: "#334155", marginLeft: 6, fontSize: 10 }}>{new Date(entry.ts).toLocaleTimeString()}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QAChecklist({ checklist }) {
  if (!checklist?.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>QA Checklist</div>
      {checklist.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, fontSize: 12 }}>
          <span style={{ flexShrink: 0 }}>{QA_ICON[item.status] ?? "•"}</span>
          <div>
            <span style={{ color: "#cbd5e1", fontWeight: 600 }}>{item.requirement}</span>
            {item.note && <span style={{ color: "#64748b" }}> — {item.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Pending approvals panel ────────────────────────────────────────────

function PendingApprovals({ pending, onApprove, onCancel }) {
  if (!pending?.approvals?.length && !pending?.cancelWindows?.length) return null;

  return (
    <div style={{ background: "#1a1120", border: "1px solid #f97316aa", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#f97316", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
        🔐 Requires Your Attention
      </div>

      {pending.approvals.map(p => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <span style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 13 }}>
              ${Number(p.ctx.totalUSD).toFixed(2)} for {p.ctx.freelancerName}
            </span>
            <span style={{ color: "#64748b", fontSize: 12, marginLeft: 8 }}>above auto-approve limit</span>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 2 }}>
              Expires in <Countdown expiresAt={p.expiresAt} />
            </div>
          </div>
          <button onClick={() => onApprove(p.id)} style={btnStyle("#10b981")}>✓ Approve</button>
          <button onClick={() => onCancel(p.id)} style={btnStyle("#ef4444")}>✗ Cancel</button>
        </div>
      ))}

      {pending.cancelWindows.map(cw => (
        <div key={cw.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <span style={{ color: "#e2e8f0", fontSize: 13 }}>Payment scheduled</span>
            <span style={{ color: "#64748b", fontSize: 12, marginLeft: 8 }}>auto-executes in <Countdown expiresAt={cw.expiresAt} /></span>
          </div>
          <button onClick={() => onCancel(cw.id)} style={btnStyle("#ef4444")}>✗ Cancel</button>
        </div>
      ))}
    </div>
  );
}

const btnStyle = (color) => ({
  background: color + "22", color, border: `1px solid ${color}55`,
  borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700,
  cursor: "pointer", whiteSpace: "nowrap",
});

// ── Transaction row ────────────────────────────────────────────────────

function TxRow({ tx, onApprove, onCancel }) {
  const [open, setOpen] = useState(false);
  const m = STATUS_META[tx.status] ?? { color: "#9ca3af", label: tx.status, dot: "•" };
  const isQA = tx.emailType === "submission";
  const isPendingApproval = tx.status === "pending_approval";
  const isCancelWindow = tx.status === "pending_cancel_window";

  return (
    <div style={{
      background: "#1e1e2e",
      border: `1px solid ${isPendingApproval ? "#f97316aa" : isCancelWindow ? "#f59e0b66" : open ? m.color + "44" : "#2a2a3e"}`,
      borderRadius: 10, padding: "12px 16px", cursor: "pointer", transition: "border-color 0.15s",
    }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge label={`${m.dot} ${m.label.toUpperCase()}`} color={m.color} />
        {isQA && <Badge label="QA" color="#818cf8" small />}

        <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 13 }}>{tx.freelancerName ?? "…"}</span>
        {tx.projectName && tx.projectName !== "Unknown" && (
          <span style={{ color: "#6b7280", fontSize: 11 }}>· {tx.projectName}</span>
        )}

        {tx.confidence != null && <Badge label={`${Math.round(tx.confidence * 100)}% conf`} color={CC(tx.confidence)} small />}
        {tx.qaScore != null && <Badge label={`QA ${Math.round(tx.qaScore * 100)}%`} color={CC(tx.qaScore)} small />}
        {tx.agentFeeUSD > 0 && <Badge label={`fee $${tx.agentFeeUSD.toFixed(3)}`} color="#818cf8" small />}

        {isCancelWindow && tx.cancelExpiresAt && (
          <span style={{ fontSize: 11, color: "#f59e0b" }}>cancel in <Countdown expiresAt={tx.cancelExpiresAt} /></span>
        )}

        <span style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 13, fontWeight: 600 }}>
          {tx.totalUSD != null ? `$${Number(tx.totalUSD).toFixed(2)}` : ""}
        </span>
        <span style={{ color: "#475569", fontSize: 10 }}>{new Date(tx.processedAt).toLocaleTimeString()}</span>
        <span style={{ color: "#475569", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </div>

      {/* Inline approve/cancel for pending rows */}
      {(isPendingApproval || isCancelWindow) && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {isPendingApproval && (
            <button onClick={(e) => { e.stopPropagation(); onApprove(tx.id); }} style={btnStyle("#10b981")}>
              ✓ Approve ${Number(tx.totalUSD).toFixed(2)}
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onCancel(tx.id); }} style={btnStyle("#ef4444")}>
            ✗ Cancel
          </button>
        </div>
      )}

      {open && (
        <div style={{ marginTop: 12, borderTop: "1px solid #2a2a3e", paddingTop: 12, fontSize: 12, color: "#94a3b8" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px", marginBottom: 8 }}>
            {tx.hours != null && <div><b style={{ color: "#cbd5e1" }}>Hours:</b> {tx.hours}h</div>}
            {tx.hourlyRate != null && <div><b style={{ color: "#cbd5e1" }}>Rate:</b> ${tx.hourlyRate}/h</div>}
            {tx.partialPaymentPct != null && tx.partialPaymentPct < 1 && (
              <div><b style={{ color: "#f59e0b" }}>Partial:</b> {Math.round(tx.partialPaymentPct * 100)}%</div>
            )}
            {tx.remainingPayment > 0 && (
              <div><b style={{ color: "#f59e0b" }}>Remaining:</b> ${Number(tx.remainingPayment).toFixed(2)}</div>
            )}
            {tx.emailFrom && <div style={{ gridColumn: "1/-1" }}><b style={{ color: "#cbd5e1" }}>From:</b> {tx.emailFrom}</div>}
          </div>

          {tx.qaScore != null && <div style={{ marginBottom: 8 }}><b style={{ color: "#cbd5e1" }}>QA Score: </b><ScoreBar score={tx.qaScore} /></div>}
          {tx.confidence != null && !isQA && <div style={{ marginBottom: 8 }}><b style={{ color: "#cbd5e1" }}>Parse confidence: </b><ScoreBar score={tx.confidence} /></div>}
          {tx.performanceMultiplier != null && tx.performanceMultiplier !== 1 && (
            <div style={{ marginBottom: 6, padding: "6px 10px", background: tx.performanceMultiplier > 1 ? "#10b98115" : "#ef444415", borderRadius: 6, border: `1px solid ${tx.performanceMultiplier > 1 ? "#10b98133" : "#ef444433"}` }}>
              <b style={{ color: tx.performanceMultiplier > 1 ? "#10b981" : "#ef4444" }}>
                {tx.performanceMultiplier > 1 ? `⬆ +${Math.round((tx.performanceMultiplier - 1) * 100)}% bonus` : `⬇ ${Math.round((1 - tx.performanceMultiplier) * 100)}% penalty`}:
              </b>
              <span style={{ color: "#94a3b8", marginLeft: 6 }}>{tx.performanceReasoning}</span>
            </div>
          )}
          {tx.reason && <div style={{ marginBottom: 6 }}><b style={{ color: "#cbd5e1" }}>Reason: </b>{tx.reason}</div>}

          <QAChecklist checklist={tx.qaChecklist} />
          <DecisionLog log={tx.decisionLog} />

          {tx.explorerUrl && (
            <div style={{ marginTop: 8, wordBreak: "break-all" }}>
              <b style={{ color: "#cbd5e1" }}>Tx: </b>
              <a href={tx.explorerUrl} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ color: "#818cf8", textDecoration: "underline" }}>{tx.explorerUrl}</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────────

export default function App() {
  const [txs, setTxs] = useState([]);
  const [stats, setStats] = useState(null);
  const [pending, setPending] = useState({ approvals: [], cancelWindows: [] });
  const [lastUpdate, setLastUpdate] = useState(null);
  const [connected, setConnected] = useState(true);
  const [tab, setTab] = useState("all");
  const [digestResult, setDigestResult] = useState(null);
  const digestRef = useRef(false);
  const [showTrigger, setShowTrigger] = useState(false);
  const [triggerForm, setTriggerForm] = useState({
    subject: "timesheet - Ana Petrovic",
    from: "ana.petrovic@gmail.com",
    body: "Hi, I worked 23 hours this week on the website redesign project.\nMy rate is $45/hour.\nMy Solana wallet: WALLET_ADDRESS\n\nJust wanted to mention — I delivered everything 2 days ahead of schedule and also added a dark mode toggle that wasn't in the requirements.",
  });

  const fetchData = useCallback(async () => {
    try {
      const [txRes, statRes, pendRes] = await Promise.all([
        fetch(`${API}/transactions`), fetch(`${API}/status`), fetch(`${API}/pending`),
      ]);
      setTxs(await txRes.json());
      setStats(await statRes.json());
      setPending(await pendRes.json());
      setLastUpdate(new Date());
      setConnected(true);
    } catch { setConnected(false); }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleApprove = async (id) => {
    await fetch(`${API}/approve/${id}`, { method: "POST" });
    fetchData();
  };
  const handleCancel = async (id) => {
    await fetch(`${API}/cancel/${id}`, { method: "POST" });
    fetchData();
  };

  const triggerEmail = async () => {
    await fetch(`${API}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(triggerForm),
    });
    setShowTrigger(false);
    fetchData();
  };

  const sendDigest = async () => {
    if (digestRef.current) return;
    digestRef.current = true;
    try {
      const res = await fetch(`${API}/digest/send`, { method: "POST" });
      const data = await res.json();
      setDigestResult(data.body ?? "Sent!");
    } catch { setDigestResult("Failed to generate digest."); }
    digestRef.current = false;
  };

  const filtered = tab === "all" ? txs
    : tab === "timesheet" ? txs.filter(t => t.emailType === "timesheet")
    : txs.filter(t => t.emailType === "submission");

  const hasPending = pending.approvals.length > 0 || pending.cancelWindows.length > 0;

  return (
    <div style={{
      minHeight: "100vh", background: "#0f0f1a", color: "#e2e8f0",
      fontFamily: "'Inter','Segoe UI',sans-serif", padding: "24px 20px", maxWidth: 940, margin: "0 auto",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 26 }}>🤖</span>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#f1f5f9" }}>PayrollBot</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {hasPending && (
            <span style={{ background: "#f9731622", color: "#f97316", border: "1px solid #f9731655", borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>
              {pending.approvals.length + pending.cancelWindows.length} pending
            </span>
          )}
          <span style={{
            fontSize: 11, padding: "2px 10px", borderRadius: 999, fontWeight: 600,
            background: connected ? "#10b98122" : "#ef444422",
            color: connected ? "#10b981" : "#ef4444",
            border: `1px solid ${connected ? "#10b98155" : "#ef444455"}`,
          }}>{connected ? "● LIVE" : "● OFFLINE"}</span>
        </div>
      </div>
      <p style={{ margin: "0 0 20px", color: "#475569", fontSize: 11 }}>
        Timesheet processing · QA-gated delivery · Solana Devnet ·{" "}
        {stats && `Auto-approve ≤ $${stats.maxAutoUSD} · Cancel window ${stats.cancelWindowMs / 1000}s`} ·{" "}
        {lastUpdate ? `${lastUpdate.toLocaleTimeString()}` : "Connecting…"}
      </p>

      {/* Pending approvals */}
      <PendingApprovals pending={pending} onApprove={handleApprove} onCancel={handleCancel} />

      {/* Stats */}
      {stats && (
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <StatCard label="Processed" value={stats.totalProcessed} color="#818cf8" />
          <StatCard label="Paid" value={stats.approved} color="#10b981" />
          <StatCard label="Flagged/Partial" value={stats.flagged} color="#f97316" />
          <StatCard label="Rejected" value={stats.rejected} color="#ef4444" />
          <StatCard label="Agent Earned" value={`$${Number(stats.agentTotalEarnedUSD ?? 0).toFixed(3)}`}
            sub={`of $${Number(stats.totalVolumeUSD ?? 0).toFixed(0)} volume`} color="#818cf8" />
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        {["all","timesheet","submission"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? "#818cf8" : "#1e1e2e",
            color: tab === t ? "#fff" : "#64748b",
            border: "1px solid " + (tab === t ? "#818cf8" : "#2a2a3e"),
            borderRadius: 7, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
          }}>{t === "all" ? "All" : t === "timesheet" ? "⏱ Timesheets" : "📦 Submissions"}</button>
        ))}
        <button onClick={() => setShowTrigger(s => !s)} style={{ ...btnStyle("#6366f1"), marginLeft: "auto", fontSize: 11 }}>
          ⚡ Trigger Email
        </button>
        <button onClick={sendDigest} style={{ ...btnStyle("#64748b"), fontSize: 11 }}>
          📋 Digest
        </button>
      </div>

      {showTrigger && (
        <div style={{ background: "#1e1e2e", border: "1px solid #6366f1aa", borderRadius: 10, padding: "16px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontWeight: 700 }}>⚡ Manual Email Trigger</div>
          {["subject","from","body"].map(field => (
            <div key={field} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "#475569", marginBottom: 3, textTransform: "uppercase" }}>{field}</div>
              {field === "body"
                ? <textarea value={triggerForm[field]} onChange={e => setTriggerForm(f => ({ ...f, [field]: e.target.value }))}
                    style={{ width: "100%", background: "#0f0f1a", color: "#e2e8f0", border: "1px solid #2a2a3e", borderRadius: 6, padding: "8px", fontSize: 12, fontFamily: "monospace", height: 100, resize: "vertical", boxSizing: "border-box" }} />
                : <input value={triggerForm[field]} onChange={e => setTriggerForm(f => ({ ...f, [field]: e.target.value }))}
                    style={{ width: "100%", background: "#0f0f1a", color: "#e2e8f0", border: "1px solid #2a2a3e", borderRadius: 6, padding: "7px 10px", fontSize: 12, boxSizing: "border-box" }} />
              }
            </div>
          ))}
          <button onClick={triggerEmail} style={{ ...btnStyle("#6366f1"), fontSize: 12, marginTop: 4 }}>
            ▶ Process Email
          </button>
        </div>
      )}

      {digestResult && (
        <div style={{ background: "#1e1e2e", border: "1px solid #2a2a3e", borderRadius: 8, padding: "12px 16px", marginBottom: 14, fontSize: 12, color: "#94a3b8", whiteSpace: "pre-wrap" }}>
          <div style={{ fontSize: 10, color: "#475569", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Digest Preview</div>
          {digestResult}
          <button onClick={() => setDigestResult(null)} style={{ display: "block", marginTop: 8, fontSize: 10, color: "#475569", background: "none", border: "none", cursor: "pointer" }}>dismiss</button>
        </div>
      )}

      {/* Feed */}
      {filtered.length === 0 ? (
        <div style={{ background: "#1e1e2e", border: "1px dashed #2a2a3e", borderRadius: 10, padding: "32px 20px", textAlign: "center", color: "#475569" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📬</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Waiting for emails…</div>
          <div style={{ fontSize: 11, marginTop: 5 }}>
            <code style={{ background: "#2a2a3e", padding: "1px 5px", borderRadius: 3 }}>timesheet - project-id</code>
            {" or "}
            <code style={{ background: "#2a2a3e", padding: "1px 5px", borderRadius: 3 }}>submission - project-id</code>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {filtered.map(tx => (
            <TxRow key={tx.id} tx={tx} onApprove={handleApprove} onCancel={handleCancel} />
          ))}
        </div>
      )}

      <p style={{ textAlign: "center", color: "#1e293b", fontSize: 10, marginTop: 24 }}>
        Every decision logged with reasoning · Cancel window on all payments · Explicit approval above ${stats?.maxAutoUSD ?? "…"} · Agent fee 0.5%
      </p>
    </div>
  );
}
