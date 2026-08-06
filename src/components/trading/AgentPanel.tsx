import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Cpu, Send, MessageSquare, Loader2, BookOpen, RefreshCw,
  Settings2, ChevronDown, ChevronUp, Zap, ExternalLink, Check,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useStrategies } from "@/lib/strategiesContext";
import { useChat } from "@/lib/chatContext";
import { supabase } from "@/integrations/supabase/client";

const FALLBACK_MODELS = [
  { id: "openai/gpt-4.1",              name: "GPT-4.1",           provider: "OpenAI",    tier: "recommended" },
  { id: "openai/gpt-4.1-mini",         name: "GPT-4.1 Mini",      provider: "OpenAI",    tier: "fast"        },
  { id: "openai/gpt-4o",               name: "GPT-4o",            provider: "OpenAI",    tier: "smart"       },
  { id: "openai/gpt-4o-mini",          name: "GPT-4o Mini",       provider: "OpenAI",    tier: "cheap"       },
  { id: "google/gemini-2.5-pro",       name: "Gemini 2.5 Pro",    provider: "Google",    tier: "smart"       },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", tier: "smart"       },
  { id: "anthropic/claude-opus-4-7",   name: "Claude Opus 4.7",   provider: "Anthropic", tier: "premium"     },
];

interface AIModel { id: string; name: string; provider: string; tier?: string; }
type Msg = { role: "user" | "assistant"; content: string };

const LIST_MODELS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/list-ai-models`;
const AGENT_URL      = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-agent`;

const QUICK_PROMPTS = [
  { label: "Portfolio status",    text: "Give me a full status update — P&L, open positions, and how each strategy is performing." },
  { label: "Best opportunities",  text: "Scan Kalshi markets and show me the top 3 opportunities right now with confidence levels." },
  { label: "What traded today?",  text: "What did the agent trade today? Show me the trades, reasoning, and P&L." },
  { label: "Risk check",          text: "Review my risk exposure across all open positions and flag anything outside my risk parameters." },
  { label: "New strategy",        text: "I want to create a new strategy. Ask me what market type and edge I want to target." },
];

async function streamChat({
  messages, strategies, model, temperature, systemPrompt, tradingMode, conversationId, onDelta, onDone, onError, onStatus, onConversationId,
}: {
  messages: Msg[]; strategies: { name: string; instructions: string }[];
  model: string; temperature: number; systemPrompt: string; tradingMode: string;
  conversationId: string | null;
  onDelta: (text: string) => void; onDone: () => void; onError: (error: string) => void;
  onStatus?: (text: string) => void;
  onConversationId?: (id: string) => void;
}) {
  const resp = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim()}`,
    },
    body: JSON.stringify({ messages, strategies, model, temperature, systemPrompt, tradingMode, conversationId }),
  });
  if (!resp.ok) { const err = await resp.json().catch(() => ({ error: "Unknown error" })); onError(err.error || `Error ${resp.status}`); return; }
  if (!resp.body) { onError("No response body"); return; }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith(":") || line.trim() === "" || !line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") { done = true; break; }
      try {
        const p = JSON.parse(jsonStr);
        if (p.type === "status") { onStatus?.(p.text); continue; }
        if (p.type === "conversation_id") { onConversationId?.(p.conversationId); continue; }
        const c = p.choices?.[0]?.delta?.content; if (c) onDelta(c);
      } catch { buffer = line + "\n" + buffer; break; }
    }
  }
  if (buffer.trim()) {
    for (const raw of buffer.split("\n")) {
      if (!raw || !raw.startsWith("data: ")) continue;
      const jsonStr = raw.replace(/\r$/, "").slice(6).trim();
      if (jsonStr === "[DONE]") continue;
      try { const p = JSON.parse(jsonStr); const c = p.choices?.[0]?.delta?.content; if (c) onDelta(c); } catch {}
    }
  }
  onDone();
}

export function AgentPanel({ mode = "paper", onOpenMarket }: { mode?: "paper" | "live"; onOpenMarket?: (ticker: string) => void }) {
  // Memoised value, not getActiveStrategies() — calling that during render
  // returned a fresh array each pass and made loadPositionSizes' effect below
  // re-fire indefinitely (15+ duplicate strategy_config fetches per load).
  const { activeStrategies } = useStrategies();
  const chat = useChat("agent");
  const [models, setModels] = useState<AIModel[]>(FALLBACK_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState(FALLBACK_MODELS[0].id);
  const [temperature, setTemperature] = useState([0.3]);
  const [userId, setUserId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState(
    `You are the orchestration layer of an autonomous trading system on Kalshi prediction markets. You have two roles:

1. ANSWER questions about the portfolio — P&L, open positions, trade history, strategy performance, risk exposure. Use your tools to fetch live data before answering. Never guess numbers you can retrieve.

2. ACT on user commands — trigger strategy runs, create new strategies, place manual trades, adjust risk settings. When the user says "run S-002" or "trade this market", do it via your tools.

The EXECUTOR (auto-trade function) handles scheduled cron-based trades. You handle everything the user asks for directly.

Tone: direct and data-driven. Lead with numbers. Flag risks. No filler.`
  );
  const [chatInput, setChatInput] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [statusText, setStatusText] = useState("");
  // Per-strategy max position size (in USD) — saved to strategy_config.max_position_usd
  const [positionSizes, setPositionSizes] = useState<Record<string, string>>({});
  const [savingPositionSize, setSavingPositionSize] = useState<Record<string, boolean>>({});
  const [savedPositionSize, setSavedPositionSize] = useState<Record<string, boolean>>({});
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const chatMessages = chat.messages;
  const isLoading = chat.isLoading;

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      // Session JWT, not the publishable key. The publishable key was rejected
      // with a 401 on every dashboard load — the model picker silently fell back
      // to FALLBACK_MODELS and the user's own configured model was never listed.
      // This function decrypts that user's AI provider key, so it needs the real
      // caller identity regardless; sending an anon key here was never correct.
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setLoadingModels(false);
        return; // signed out — nothing to personalise, keep the fallback list
      }
      const [modelsRes, prefRow] = await Promise.all([
        fetch(LIST_MODELS_URL, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        supabase.from("api_keys").select("key_id").eq("provider", "model_agent").maybeSingle(),
      ]);
      const data = await modelsRes.json();
      if (data.models?.length > 0) {
        setModels(data.models);
        const savedId = prefRow.data?.key_id;
        if (savedId && data.models.find((m: AIModel) => m.id === savedId)) {
          setSelectedModel(savedId);
        } else if (data.models[0]) {
          setSelectedModel(data.models[0].id);
        }
      } else {
        const savedId = prefRow.data?.key_id;
        if (savedId) setSelectedModel(savedId);
      }
    } catch {
      // fall back to FALLBACK_MODELS
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);

  // Load per-strategy max_position_usd from strategy_config
  const loadPositionSizes = useCallback(async () => {
    if (activeStrategies.length === 0) return;
    const ids = activeStrategies.map(s => s.id);
    const { data } = await supabase
      .from("strategy_config")
      .select("strategy_id, max_position_usd")
      .in("strategy_id", ids);
    if (!data) return;
    const map: Record<string, string> = {};
    for (const row of data) {
      if (row.max_position_usd != null) map[row.strategy_id] = String(row.max_position_usd);
    }
    setPositionSizes(map);
  }, [activeStrategies]);

  useEffect(() => { loadPositionSizes(); }, [loadPositionSizes]);

  const savePositionSize = async (strategyId: string, value: string) => {
    const parsed = parseInt(value, 10);
    if (!value || isNaN(parsed) || parsed < 1) return;
    setSavingPositionSize(prev => ({ ...prev, [strategyId]: true }));
    // Plain UPDATE, not upsert: strategy_config INSERT is service-role-only
    // (a DB trigger seeds the row on strategy creation, so it always exists),
    // and INSERT..ON CONFLICT needs INSERT privilege even when it resolves to
    // an update. The old upsert also never checked its error — it silently
    // failed for weeks after RLS tightened, showing a ✓ while saving nothing.
    const { error, count } = await supabase
      .from("strategy_config")
      .update({ max_position_usd: parsed, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("strategy_id", strategyId);
    setSavingPositionSize(prev => ({ ...prev, [strategyId]: false }));
    if (error || count === 0) {
      toast.error(error ? `Position size not saved: ${error.message}` : "Position size not saved — config row not found.");
      return;
    }
    setSavedPositionSize(prev => ({ ...prev, [strategyId]: true }));
    setTimeout(() => setSavedPositionSize(prev => ({ ...prev, [strategyId]: false })), 2000);
  };

  // Resolve current user and restore prior conversation on mount
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const uid = data.user?.id ?? null;
      setUserId(uid);
      if (!uid) return;

      const savedConvId = localStorage.getItem(`conversation_${uid}`);
      if (!savedConvId) return;
      setConversationId(savedConvId);

      supabase
        .from("chat_messages")
        .select("role, content, created_at")
        .eq("conversation_id", savedConvId)
        .order("created_at", { ascending: true })
        .limit(50)
        .then(({ data: msgs }) => {
          if (!msgs || msgs.length === 0) return;
          // Only restore if chat is currently showing just the default greeting (avoid overwriting live session)
          if (chat.messages.length > 1) return;
          const restored = msgs.map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
          chat.setMessages(restored);
        });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;
    chat.addUserMessage(text);
    const messagesForApi = [...chatMessages, { role: "user" as const, content: text }];
    setChatInput("");
    chat.setLoading(true);
    let assistantSoFar = "";
    await streamChat({
      messages: messagesForApi.slice(1).slice(-12),
      strategies: activeStrategies.map(s => ({ id: s.id, name: s.name, instructions: s.instructions })),
      model: selectedModel, temperature: temperature[0], systemPrompt, tradingMode: mode,
      conversationId,
      onDelta: (chunk) => { assistantSoFar += chunk; chat.upsertAssistant(assistantSoFar); },
      onDone: () => { chat.setLoading(false); setStatusText(""); },
      onError: (err) => { chat.upsertAssistant(`Error: ${err}`); chat.setLoading(false); setStatusText(""); },
      onStatus: (text) => setStatusText(text),
      onConversationId: (id) => {
        setConversationId(id);
        if (userId) localStorage.setItem(`conversation_${userId}`, id);
      },
    });
  };

  const currentModel = models.find(m => m.id === selectedModel) ?? models[0];

  const tickerComponents = useMemo(() => ({
    code({ inline, children, ...props }: any) {
      const text = String(children).trim();
      if (inline && /^KX[A-Z]+-[A-Z0-9]/.test(text) && onOpenMarket) {
        return (
          <button
            onClick={() => onOpenMarket(text)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
            title={`Open ${text} in Markets`}
          >
            {text}
            <ExternalLink className="h-2.5 w-2.5 opacity-70" />
          </button>
        );
      }
      return <code className="text-xs bg-background/50 px-1 rounded-md" {...props}>{children}</code>;
    }
  }), [onOpenMarket]);

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden flex flex-col apple-reveal"
      style={{ minHeight: "520px", height: "clamp(520px, 65vh, 700px)" }}>

      {/* Header */}
      <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`h-2 w-2 rounded-full shrink-0 ${mode === "live" ? "bg-red-500" : "bg-profit"} animate-pulse-gentle`} />
          <h3 className="text-sm font-medium text-foreground shrink-0">Agent</h3>
          {isLoading && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
              <Loader2 className="h-3 w-3 animate-spin" /> {statusText || "Thinking…"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Static model chip — non-interactive, shows active model */}
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary rounded-full px-2 py-1 shrink-0">
            <Cpu className="h-3 w-3" />
            <span className="truncate max-w-[80px]">{currentModel?.name ?? "GPT-4o Mini"}</span>
          </div>
          <button
            onClick={() => setConfigOpen(o => !o)}
            className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors rounded-lg p-1.5 hover:bg-secondary shrink-0"
            title="Advanced settings"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {configOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Collapsible config — temperature + strategies + advanced prompt */}
      {configOpen && (
        <div className="border-b border-border bg-secondary/30 px-4 sm:px-5 py-4 space-y-3 shrink-0">
          {/* Model selector row */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div>
                  <Label className="text-xs text-foreground">Agent Model</Label>
                  <p className="text-[10px] text-muted-foreground">Powers chat + auto-trading executor</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={loadModels} disabled={loadingModels} className="text-muted-foreground hover:text-foreground transition-colors" title="Reload models">
                  {loadingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </button>
                <Select value={selectedModel} onValueChange={async (id) => {
                  setSelectedModel(id);
                  const { data: { user } } = await supabase.auth.getUser();
                  if (user) await supabase.from("api_keys").upsert(
                    { user_id: user.id, provider: "model_agent", key_id: id },
                    { onConflict: "provider,user_id" }
                  );
                }}>
                  <SelectTrigger className="h-8 rounded-xl text-xs w-[160px] shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="flex items-center gap-2 text-xs">
                          {m.name}
                          <span className="text-[10px] text-muted-foreground">{m.provider}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          {/* Creativity slider */}
          <div className="flex items-center gap-2 flex-1">
            <Label className="text-xs text-muted-foreground shrink-0">Creativity</Label>
            <Slider value={temperature} onValueChange={setTemperature} max={1} step={0.05} className="flex-1" />
            <span className="text-xs text-muted-foreground shrink-0">
              {temperature[0] <= 0.2 ? "Precise" : temperature[0] <= 0.5 ? "Balanced" : temperature[0] <= 0.7 ? "Creative" : "Wild"}
            </span>
          </div>
          {activeStrategies.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BookOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground">Max order size per strategy</span>
              </div>
              {activeStrategies.map(s => (
                <div key={s.id} className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px] rounded-full font-normal shrink-0 min-w-[90px] justify-center">{s.name}</Badge>
                  <div className="relative flex-1">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">$</span>
                    <Input
                      type="number"
                      min={1}
                      step={5}
                      placeholder="default"
                      value={positionSizes[s.id] ?? ""}
                      onChange={e => setPositionSizes(prev => ({ ...prev, [s.id]: e.target.value }))}
                      onBlur={e => savePositionSize(s.id, e.target.value)}
                      onKeyDown={e => e.key === "Enter" && savePositionSize(s.id, positionSizes[s.id] ?? "")}
                      className="h-7 pl-6 rounded-lg border-0 bg-background text-xs tabular-nums"
                    />
                  </div>
                  <div className="w-4 shrink-0">
                    {savingPositionSize[s.id] && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    {savedPositionSize[s.id] && <Check className="h-3.5 w-3.5 text-profit" />}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground pl-0.5">Max USD per individual trade. Leave blank to use strategy defaults (S-001: $15/leg, S-005: $30).</p>
            </div>
          )}
          <button
            onClick={() => setAdvancedOpen(o => !o)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            {advancedOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            System prompt
          </button>
          {advancedOpen && (
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="rounded-xl border-0 bg-background text-xs min-h-[100px] resize-none font-mono"
            />
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3">
        {chatMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-8">
            <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Zap className="h-6 w-6 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Your agent is ready</p>
              <p className="text-xs text-muted-foreground mt-1">
                Ask it to scan markets, suggest trades, or analyze a position.
              </p>
            </div>
          </div>
        ) : (
          chatMessages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground"
              }`}>
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_code]:text-xs [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded-md [&_strong]:font-medium">
                    <ReactMarkdown components={tickerComponents}>{msg.content}</ReactMarkdown>
                  </div>
                ) : msg.content}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Quick prompts — only when chat is empty */}
      {chatMessages.length === 0 && (
        <div className="px-4 sm:px-5 pb-2 overflow-x-auto scrollbar-none">
          <div className="flex gap-2 w-max">
            {QUICK_PROMPTS.map((qp) => (
              <button
                key={qp.label}
                onClick={() => sendMessage(qp.text)}
                disabled={isLoading}
                className="shrink-0 px-3 py-1.5 rounded-full bg-secondary hover:bg-secondary/80 text-xs text-foreground transition-colors active:scale-95"
              >
                {qp.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-4 sm:px-5 py-3.5 border-t border-border shrink-0">
        <div className="flex gap-2">
          <Input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage(chatInput)}
            placeholder={isLoading ? "Agent is thinking…" : mode === "live" ? "Tell the agent what to do…" : "Ask the agent to analyze or trade…"}
            className="rounded-full border-0 bg-secondary text-sm h-11 px-4"
            disabled={isLoading}
          />
          <Button
            size="icon"
            onClick={() => sendMessage(chatInput)}
            disabled={isLoading || !chatInput.trim()}
            className="rounded-full h-11 w-11 shrink-0"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
