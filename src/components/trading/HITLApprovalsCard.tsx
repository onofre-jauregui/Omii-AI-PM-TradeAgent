import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle, XCircle, Clock, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface HITLApproval {
  id: string;
  status: "pending" | "approved" | "rejected" | "timed_out";
  trade_payload: {
    ticker: string;
    side: string;
    action: string;
    price: number;
    amount: number;
    strategy?: string;
    notes?: string;
  };
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

function TimeAgo({ iso }: { iso: string }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    function fmt() {
      const diffMs = Date.now() - new Date(iso).getTime();
      const s = Math.floor(diffMs / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      return `${Math.floor(m / 60)}h ago`;
    }
    setLabel(fmt());
    const id = setInterval(() => setLabel(fmt()), 5000);
    return () => clearInterval(id);
  }, [iso]);
  return <span>{label}</span>;
}

function PendingCountdown({ requestedAt }: { requestedAt: string }) {
  const [remaining, setRemaining] = useState(60);
  useEffect(() => {
    function calc() {
      const elapsed = (Date.now() - new Date(requestedAt).getTime()) / 1000;
      return Math.max(0, Math.round(60 - elapsed));
    }
    setRemaining(calc());
    const id = setInterval(() => setRemaining(calc()), 500);
    return () => clearInterval(id);
  }, [requestedAt]);

  const pct = (remaining / 60) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-6 w-6 shrink-0">
        <svg className="h-6 w-6 -rotate-90" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
          <circle
            cx="12" cy="12" r="10" fill="none"
            stroke={remaining > 20 ? "hsl(var(--warning))" : "hsl(var(--loss))"}
            strokeWidth="2"
            strokeDasharray={`${2 * Math.PI * 10}`}
            strokeDashoffset={`${2 * Math.PI * 10 * (1 - pct / 100)}`}
            style={{ transition: "stroke-dashoffset 0.5s linear" }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold tabular-nums text-foreground">
          {remaining}
        </span>
      </div>
      <span className={cn(
        "text-xs font-medium tabular-nums",
        remaining > 20 ? "text-warning" : "text-loss"
      )}>
        {remaining}s to decide
      </span>
    </div>
  );
}

function ApprovalRow({
  approval,
  onDecide,
}: {
  approval: HITLApproval;
  onDecide: (id: string, decision: "approved" | "rejected") => Promise<void>;
}) {
  const [deciding, setDeciding] = useState<"approved" | "rejected" | null>(null);
  const p = approval.trade_payload;
  const tradeValue = p ? Math.round((p.amount * p.price) / 100) : 0;

  async function decide(d: "approved" | "rejected") {
    setDeciding(d);
    await onDecide(approval.id, d);
    setDeciding(null);
  }

  const isPending = approval.status === "pending";

  return (
    <div className={cn(
      "rounded-xl border p-3.5 space-y-3 transition-colors",
      isPending ? "border-warning/30 bg-warning/5" : "border-border bg-card/50",
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{p?.ticker ?? "—"}</p>
          <p className="text-xs text-muted-foreground">
            {p?.side?.toUpperCase()} {p?.action?.toUpperCase()} · ${tradeValue} @ {p?.price}¢
            {p?.strategy ? ` · ${p.strategy}` : ""}
          </p>
        </div>
        <StatusChip status={approval.status} />
      </div>

      {/* Countdown + actions for pending */}
      {isPending && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PendingCountdown requestedAt={approval.requested_at} />
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => decide("rejected")}
              disabled={!!deciding}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-loss/10 text-loss hover:bg-loss/20 transition-colors disabled:opacity-50"
            >
              {deciding === "rejected" ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
              Reject
            </button>
            <button
              onClick={() => decide("approved")}
              disabled={!!deciding}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-profit/10 text-profit hover:bg-profit/20 transition-colors disabled:opacity-50"
            >
              {deciding === "approved" ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
              Approve
            </button>
          </div>
        </div>
      )}

      {/* Result line for decided */}
      {!isPending && (
        <p className="text-[11px] text-muted-foreground">
          {approval.decision_note ?? approval.status} · <TimeAgo iso={approval.decided_at ?? approval.requested_at} />
        </p>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: HITLApproval["status"] }) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide bg-warning/15 text-warning px-2 py-0.5 rounded-full shrink-0">
        <Clock className="h-2.5 w-2.5" /> Pending
      </span>
    );
  }
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide bg-profit/15 text-profit px-2 py-0.5 rounded-full shrink-0">
        <CheckCircle className="h-2.5 w-2.5" /> Approved
      </span>
    );
  }
  if (status === "rejected" || status === "timed_out") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide bg-loss/15 text-loss px-2 py-0.5 rounded-full shrink-0">
        <XCircle className="h-2.5 w-2.5" /> {status === "timed_out" ? "Timed out" : "Rejected"}
      </span>
    );
  }
  return null;
}

export function HITLApprovalsCard({ userId }: { userId?: string }) {
  const [approvals, setApprovals] = useState<HITLApproval[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!userId) return;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("hitl_approvals")
      .select("*")
      .eq("user_id", userId)
      .gte("requested_at", since)
      .order("requested_at", { ascending: false })
      .limit(10);
    setApprovals((data as HITLApproval[]) ?? []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
    // Poll every 5s while there are pending approvals — real-time without websocket overhead
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  // Also listen for DB changes so the card updates when telegram-webhook decides
  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel("hitl-approvals-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "hitl_approvals", filter: `user_id=eq.${userId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId, load]);

  async function handleDecide(approvalId: string, decision: "approved" | "rejected") {
    const { error } = await supabase
      .from("hitl_approvals")
      .update({
        status: decision,
        decided_at: new Date().toISOString(),
        decision_note: `${decision} via dashboard by operator`,
      })
      .eq("id", approvalId)
      .eq("status", "pending");

    if (!error) {
      // Optimistic update
      setApprovals(prev => prev.map(a =>
        a.id === approvalId
          ? { ...a, status: decision, decided_at: new Date().toISOString(), decision_note: `${decision} via dashboard` }
          : a
      ));
      // If approved, trigger execution via the edge function
      if (decision === "approved") {
        const approval = approvals.find(a => a.id === approvalId);
        if (approval?.trade_payload) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/execute-trade`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${session.access_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ...approval.trade_payload,
                hitlApprovalId: approvalId,
              }),
            }).catch(() => {}); // fire-and-forget; compliance_log captures result
          }
        }
      }
    }
  }

  const pending = approvals.filter(a => a.status === "pending");
  const recent = approvals.filter(a => a.status !== "pending");

  if (loading) return null;
  if (approvals.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <ShieldAlert className={cn(
          "h-4 w-4 shrink-0",
          pending.length > 0 ? "text-warning animate-pulse" : "text-muted-foreground"
        )} />
        <h2 className="text-sm font-semibold text-foreground">
          Trade Approvals
        </h2>
        {pending.length > 0 && (
          <span className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full bg-warning text-[10px] font-bold text-background">
            {pending.length}
          </span>
        )}
      </div>

      {/* Pending first */}
      {pending.map(a => (
        <ApprovalRow key={a.id} approval={a} onDecide={handleDecide} />
      ))}

      {/* Recent decided */}
      {recent.length > 0 && (
        <div className="space-y-2">
          {recent.slice(0, 3).map(a => (
            <ApprovalRow key={a.id} approval={a} onDecide={handleDecide} />
          ))}
        </div>
      )}
    </div>
  );
}
