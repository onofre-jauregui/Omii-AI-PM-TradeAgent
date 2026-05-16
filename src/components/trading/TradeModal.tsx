import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ParsedMarket } from "@/lib/kalshiApi";

interface TradeModalProps {
  market: ParsedMarket | null;
  open: boolean;
  onClose: () => void;
  mode: "paper" | "live";
  initialSide?: "yes" | "no";
}

export function TradeModal({ market, open, onClose, mode, initialSide }: TradeModalProps) {
  const [side, setSide] = useState<"yes" | "no">(initialSide ?? "no");

  useEffect(() => {
    if (initialSide) setSide(initialSide);
  }, [initialSide, open]);
  const [amount, setAmount] = useState(20);
  const [price, setPrice] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [strategies, setStrategies] = useState<{ id: string; name: string }[]>([]);
  const [strategyId, setStrategyId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!market) return;
    const defaultPrice = side === "yes"
      ? Math.round((market.yesAsk ?? 0.5) * 100)
      : Math.round((market.noAsk ?? 0.5) * 100);
    setPrice(Math.max(1, Math.min(99, defaultPrice || 50)));
    setError(null);
  }, [market, side]);

  useEffect(() => {
    supabase.from("strategies").select("id, name").eq("active", true).then(({ data }) => {
      setStrategies(data ?? []);
    });
  }, []);

  async function handleSubmit() {
    if (!market) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/execute-trade`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          ticker: market.ticker,
          marketQuestion: market.question,
          side,
          action: "buy",
          price,
          amount,
          mode,
          ...(strategyId && strategyId !== "none" ? { strategyId } : {}),
          orderType: "limit",
        }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.success) throw new Error(result.error ?? "Trade failed");
      toast.success(`Trade filled · ${market.ticker} ${side.toUpperCase()} @ ${price}¢ for $${amount}`);
      onClose();
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  if (!market) return null;

  const quickAmounts = [5, 10, 20, 50];
  const maxWin = side === "yes"
    ? parseFloat(((amount / (price / 100)) * (1 - price / 100)).toFixed(2))
    : parseFloat(((amount / ((100 - price) / 100)) * (price / 100)).toFixed(2));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-medium leading-tight pr-6">
            {market.question}
          </DialogTitle>
          <p className="text-xs text-muted-foreground font-mono">{market.ticker}</p>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Side toggle */}
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Position</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["yes", "no"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={cn(
                    "h-11 rounded-xl text-sm font-semibold transition-all",
                    side === s
                      ? s === "yes" ? "bg-profit text-white" : "bg-loss text-white"
                      : "bg-secondary text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Amount</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="h-9 w-28 text-sm"
                min={1}
                max={500}
              />
              <div className="flex gap-1 flex-1">
                {quickAmounts.map((q) => (
                  <button
                    key={q}
                    onClick={() => setAmount(q)}
                    className={cn(
                      "flex-1 h-9 rounded-lg text-xs font-medium transition-colors",
                      amount === q ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
                    )}
                  >
                    ${q}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Price slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs text-muted-foreground">Limit Price</Label>
              <span className="text-sm font-medium tabular-nums">{price}¢</span>
            </div>
            <Slider value={[price]} min={1} max={99} step={1} onValueChange={([v]) => setPrice(v)} className="w-full" />
            <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
              <span>Market: {side === "yes" ? `${Math.round((market.yesAsk ?? 0.5) * 100)}¢` : `${Math.round((market.noAsk ?? 0.5) * 100)}¢`}</span>
              <span>Max win: +${maxWin.toFixed(2)}</span>
            </div>
          </div>

          {/* Strategy (optional) */}
          {strategies.length > 0 && (
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Strategy (optional)</Label>
              <Select value={strategyId} onValueChange={setStrategyId}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="No strategy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No strategy</SelectItem>
                  {strategies.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Mode badge */}
          <div className="flex items-center justify-between text-xs text-muted-foreground bg-secondary/50 rounded-xl px-3 py-2">
            <span>{mode === "paper" ? "📄 Paper trade" : "⚡ Live trade on Kalshi"}</span>
            <span className="font-medium">${amount} at risk</span>
          </div>

          {error && <p className="text-xs text-loss">{error}</p>}

          <Button onClick={handleSubmit} disabled={submitting} className="w-full h-11 text-sm font-medium">
            {submitting ? "Placing..." : `Place ${side.toUpperCase()} order · $${amount}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
