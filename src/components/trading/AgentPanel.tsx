import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Cpu, Send, MessageSquare, Loader2, BookOpen, RefreshCw,
  Settings2, ChevronDown, ChevronUp, Zap,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { useStrategies } from "@/lib/strategiesContext";
import { useChat } from "@/lib/chatContext";
import { supabase } from "@/integrations/supabase/client";

const FALLBACK_MODELS = [
  { id: "openai/gpt-4o-mini",               name: "GPT-4o Mini",       provider: "OpenAI"     },
  { id: "openai/gpt-4o",                    name: "GPT-4o",            provider: "OpenAI"     },
  { id: "anthropic/claude-sonnet-4-6",      name: "Claude Sonnet 4.6", provider: "Anthropic"  },
  { id: "google/gemini-2.0-flash-001",      name: "Gemini 2.0 Flash",  provider: "Google"     },
  { id: "meta-llama/llama-3.1-70b-instruct",name: "Llama 3.1 70B",    provider: "Meta"       },
];

interface AIModel { id: string; name: string; provider: string; }
type Msg = { role: "user" | "assistant"; content: string };

const LIST_MODELS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/list-ai-models`;
const AGENT_URL      = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-agent`;

const QUICK_PROMPTS = [
  { label: "Best opportunities",  text: "Scan Kalshi markets and show me the 3 best trading opportunities right now." },
  { label: "Show my positions",   text: "What positions do I currently have open and how are they performing?" },
  { label: "Market summary",      text: "Give me a quick summary of today's most active prediction markets." },
  { label: "Suggest a trade",     text: "Suggest one high-confidence trade for my active strategies." },
  { label: "Risk check",          text: "Review my risk exposure and flag anything I should watch." },
];

async function streamChat({
  messages, strategies, model, temperature, systemPrompt, tradingMode, onDelta, onDone, onError,
}: {
  messages: Msg[]; strategies: { name: string; instructions: string }[];
  model: string; temperature: number; systemPrompt: string; tradingMode: string;
  onDelta: (text: string) => void; onDone: () => void; onError: (error: string) => void;
}) {
  const resp = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim()}`,
    },
    body: JSON.stringify({ messages, strategies, model, temperature, systemPrompt, tradingMode }),
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
      try { const p = JSON.parse(jsonStr); const c = p.choices?.[0]?.delta?.content; if (c) onDelta(c); }
      catch { buffer = line + "\n" + buffer; break; }
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

export function AgentPanel({ mode = "paper" }: { mode?: "paper" | "live" }) {
  const { getActiveStrategies } = useStrategies();
  const chat = useChat("agent");
  const [models, setModels] = useState<AIModel[]>(FALLBACK_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState(FALLBACK_MODELS[0].id);
  const [temperature, setTemperature] = useState([0.3]);
  const [systemPrompt, setSystemPrompt] = useState(
    `You are an expert algorithmic trading agent for Kalshi event contracts. Analyze market data, news sentiment, probability shifts, and order book depth to identify profitable trading opportunities. Use limit orders for better execution. Provide clear trade signals with entry/exit prices and confidence levels.`
  );
  const [chatInput, setChatInput] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const activeStrategies = getActiveStrategies();

  const chatMessages = chat.messages;
  const isLoading = chat.isLoading;

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [modelsRes, prefRow] = await Promise.all([
        fetch(LIST_MODELS_URL, {
          headers: { Authorization: `Bearer ${(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim()}` },
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
      onDelta: (chunk) => { assistantSoFar += chunk; chat.upsertAssistant(assistantSoFar); },
      onDone: () => chat.setLoading(false),
      onError: (err) => { chat.upsertAssistant(`Error: ${err}`); chat.setLoading(false); },
    });
  };

  const currentModel = models.find(m => m.id === selectedModel) ?? models[0];

  return (
    <div className="rounded-2xl bg-card apple-shadow overflow-hidden flex flex-col apple-reveal"
      style={{ minHeight: "520px", height: "clamp(520px, 65vh, 700px)" }}>

      {/* Header */}
      <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className={`h-2 w-2 rounded-full ${mode === "live" ? "bg-red-500" : "bg-profit"} animate-pulse-gentle`} />
          <h3 className="text-sm font-medium text-foreground">Your Agent</h3>
          {isLoading && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className={`text-[10px] rounded-full ${mode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"}`}>
            {mode === "live" ? "Live" : "Paper"}
          </Badge>
          <button
            onClick={() => setConfigOpen(o => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-lg px-2 py-1 hover:bg-secondary"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{currentModel?.name ?? "Model"}</span>
            {configOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Collapsible config */}
      {configOpen && (
        <div className="border-b border-border bg-secondary/30 px-4 sm:px-5 py-4 space-y-4 shrink-0">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">AI Model</Label>
                <button onClick={loadModels} disabled={loadingModels} className="text-muted-foreground hover:text-foreground transition-colors">
                  {loadingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </button>
              </div>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="rounded-xl border-0 bg-background text-sm h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-1.5">
                        <Cpu className="h-3 w-3 shrink-0" />
                        <span>{m.name}</span>
                        <span className="text-[10px] text-muted-foreground">{m.provider}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Creativity</Label>
                <span className="text-xs text-foreground">
                  {temperature[0] <= 0.2 ? "Precise" : temperature[0] <= 0.5 ? "Balanced" : temperature[0] <= 0.7 ? "Creative" : "Wild"}&nbsp;·&nbsp;{temperature[0]}
                </span>
              </div>
              <Slider value={temperature} onValueChange={setTemperature} max={1} step={0.05} />
            </div>
          </div>
          {activeStrategies.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <BookOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">Loaded:</span>
              {activeStrategies.map(s => (
                <Badge key={s.id} variant="secondary" className="text-[10px] rounded-full font-normal">{s.name}</Badge>
              ))}
            </div>
          )}
          <button
            onClick={() => setAdvancedOpen(o => !o)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            {advancedOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Advanced (system prompt)
          </button>
          {advancedOpen && (
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="rounded-xl border-0 bg-background text-xs min-h-[80px] resize-none"
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
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
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
