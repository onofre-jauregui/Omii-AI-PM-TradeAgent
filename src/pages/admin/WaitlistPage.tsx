import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Download, RefreshCw, ArrowLeft } from "lucide-react";

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/waitlist-admin`;

interface WaitlistRow {
  id: string;
  email: string;
  created_at: string;
}

export default function WaitlistPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<WaitlistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // This page is only ever reached through App.tsx's <AdminRoute>, which
  // already checks profiles.is_admin (DB source of truth) before rendering
  // it — the hardcoded ADMIN_EMAIL check formerly here was a second,
  // inconsistent gate that would silently lock out any other admin the
  // is_admin flag was granted to, while adding no real security (the
  // waitlist-admin edge function is the actual enforcement point and now
  // checks is_admin server-side itself).
  useEffect(() => {
    fetchWaitlist();
  }, []);

  async function fetchWaitlist() {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(FN_URL, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const json = await resp.json();
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load waitlist");
    } finally {
      setLoading(false);
    }
  }

  async function exportCSV() {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch(`${FN_URL}?format=csv`, {
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Waitlist</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {loading ? "Loading…" : `${rows.length} signups`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchWaitlist} disabled={loading} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={exportCSV} disabled={loading || rows.length === 0} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-6">
          {error}
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="text-center text-muted-foreground text-sm py-24">
          No signups yet. Share <code className="text-xs bg-secondary px-1 py-0.5 rounded">/signup</code> to start collecting.
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-2xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">#</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Email</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground">Signed Up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.id} className="border-b border-border last:border-0 hover:bg-secondary/20 transition-colors">
                  <td className="px-5 py-3 text-muted-foreground text-xs">{i + 1}</td>
                  <td className="px-5 py-3 font-mono text-xs">{row.email}</td>
                  <td className="px-5 py-3 text-muted-foreground text-xs">
                    {new Date(row.created_at).toLocaleDateString("en-US", {
                      month: "short", day: "numeric", year: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
