import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ShieldCheck, AlertTriangle, Info, XCircle, RefreshCw, Loader2, Download } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ComplianceEntry {
  id: string;
  trade_id: string | null;
  event_type: string;
  severity: string;
  message: string;
  metadata: any;
  created_at: string;
}

const severityConfig: Record<string, { icon: typeof Info; color: string; bg: string }> = {
  info: { icon: Info, color: "text-primary", bg: "bg-primary/10" },
  warning: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10" },
  error: { icon: XCircle, color: "text-loss", bg: "bg-loss/10" },
  critical: { icon: XCircle, color: "text-loss", bg: "bg-loss/20" },
};

export function CompliancePanel() {
  const [entries, setEntries] = useState<ComplianceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("compliance_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (filter) {
      query = query.eq("severity", filter);
    }

    const { data, error } = await query;
    if (!error && data) {
      setEntries(data as ComplianceEntry[]);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    loadEntries();

    const channel = supabase
      .channel("compliance-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "compliance_log" }, () => {
        loadEntries();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadEntries]);

  const exportLog = () => {
    const csv = [
      "timestamp,event_type,severity,message,trade_id",
      ...entries.map(e =>
        `"${e.created_at}","${e.event_type}","${e.severity}","${e.message.replace(/"/g, '""')}","${e.trade_id || ''}"`
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compliance-log-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const counts = {
    info: entries.filter(e => e.severity === "info").length,
    warning: entries.filter(e => e.severity === "warning").length,
    error: entries.filter(e => e.severity === "error").length,
    critical: entries.filter(e => e.severity === "critical").length,
  };

  return (
    <div className="space-y-6 apple-reveal">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-light tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>Compliance Log</h2>
          <p className="text-sm text-muted-foreground mt-1">Audit trail of all trade executions, risk checks, and system events.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={exportLog} className="rounded-full gap-1 text-xs">
            <Download className="h-3 w-3" /> Export CSV
          </Button>
          <Button variant="secondary" size="sm" onClick={loadEntries} disabled={loading} className="rounded-full gap-1 text-xs">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-3">
        {(["info", "warning", "error", "critical"] as const).map((sev) => {
          const cfg = severityConfig[sev];
          const Icon = cfg.icon;
          return (
            <button
              key={sev}
              onClick={() => setFilter(filter === sev ? null : sev)}
              className={`rounded-2xl p-4 apple-shadow transition-all duration-300 ${
                filter === sev ? "ring-1 ring-primary/30" : ""
              } bg-card`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                <span className="text-[10px] text-muted-foreground capitalize">{sev}</span>
              </div>
              <p className="text-lg font-medium tabular-nums text-foreground">{counts[sev]}</p>
            </button>
          );
        })}
      </div>

      {/* Log Entries */}
      <div className="rounded-2xl bg-card apple-shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-muted-foreground">
            Audit Log {filter && `(${filter})`}
          </h3>
          <span className="text-[10px] text-muted-foreground">({entries.length} entries)</span>
          {filter && (
            <Button variant="ghost" size="sm" onClick={() => setFilter(null)} className="h-5 text-[10px] px-2">
              Clear filter
            </Button>
          )}
        </div>
        <ScrollArea className="h-[500px]">
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <span className="text-sm text-muted-foreground">No compliance entries yet.</span>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {entries.map((entry) => {
                const cfg = severityConfig[entry.severity] || severityConfig.info;
                const Icon = cfg.icon;
                return (
                  <div key={entry.id} className="px-6 py-3 hover:bg-secondary/50 transition-colors duration-300">
                    <div className="flex items-start gap-3">
                      <div className={`p-1.5 rounded-lg ${cfg.bg} mt-0.5`}>
                        <Icon className={`h-3 w-3 ${cfg.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <Badge variant="secondary" className="text-[10px] rounded-full font-mono">
                            {entry.event_type}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(entry.created_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-foreground">{entry.message}</p>
                        {entry.trade_id && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                            Trade: {entry.trade_id.slice(0, 12)}...
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
