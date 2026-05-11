import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Cpu, Send, MessageSquare, Loader2, BookOpen, AlertTriangle, RefreshCw } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { useStrategies } from "@/lib/strategiesContext";
import { useChat } from "@/lib/chatContext";
import { supabase } from "@/integrations/supabase/client";

const FALLBACK_MODELS = [
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI" },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic" },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", provider: "Google" },
  { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B", provider: "Meta" },
];

interface AIModel { id: string; name: string; provider: string; }

const LIST_MODELS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/list-ai-models`;

type Msg = { role: "user" | "assistant"; content: string };

const AGENT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-agent`;

async function streamChat({
  messages, strategies, model, temperature, systemPrompt, tradingMode, onDelta, onDone, onError,
}: {
  messages: Msg[]; strategies: { name: string; instructions: string }[]; model: string; temperature: number; systemPrompt: string; tradingMode: string; onDelta: (text: string) => void; onDone: () => void; onError: (error: string) => void;
}) {
  const resp = await fetch(AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string)?.trim()}` },
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
    for (let raw of buffer.split("\n")) {
      if (!raw || !raw.startsWith("data: ")) continue;
      const jsonStr = raw.replace(/\r$/, "").slice(6).trim();
      if (jsonStr === "[DONE]") continue;
      try { const p = JSON.parse(jsonStr); const c = p.choices?.[0]?.delta?.content; if (c) onDelta(c); } catch {}
    }
  }
  onDone();
}

export function AgentPanel({ forcePaperMode = false }: { forcePaperMode?: boolean }) {
  const { getActiveStrategies } = useStrategies();
  const chatChannel = forcePaperMode ? "demo" : "agent";
  const chat = useChat(chatChannel);
  const [models, setModels] = useState<AIModel[]>(FALLBACK_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState(FALLBACK_MODELS[0].id);
  const [temperature, setTemperature] = useState([0.3]);
  const [tradingMode, setTradingMode] = useState<"paper" | "live">(forcePaperMode ? "paper" : "paper");
  const [systemPrompt, setSystemPrompt] = useState(
    `You are an expert algorithmic trading agent for Kalshi event contracts. Analyze market data, news sentiment, probability shifts, and order book depth to identify profitable trading opportunities. Use limit orders for better execution. Provide clear trade signals with entry/exit prices and confidence levels.`
  );
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const activeStrategies = getActiveStrategies();

  // Aliases for cleaner code below
  const chatMessages = chat.messages;
  const isLoading = chat.isLoading;

  // Load dynamic model list + saved preference on mount
  const loadModels = async () => {
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
        // Apply saved preference if it exists in the fetched list, otherwise use first model
        const savedId = prefRow.data?.key_id;
        if (savedId && data.models.find((m: AIModel) => m.id === savedId)) {
          setSelectedModel(savedId);
        } else if (data.models[0]) {
          setSelectedModel(data.models[0].id);
        }
      } else {
        // No models from server — apply saved preference against fallback list
        const savedId = prefRow.data?.key_id;
        if (savedId) setSelectedModel(savedId);
      }
    } catch {
      // Silently fall back to FALLBACK_MODELS
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => { loadModels(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Scroll only within the chat box — never move the page
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleSend = async () => {
    if (!chatInput.trim() || isLoading) return;
    chat.addUserMessage(chatInput);
    const messagesForApi = [...chatMessages, { role: "user" as const, content: chatInput }];
    setChatInput("");
    chat.setLoading(true);
    let assistantSoFar = "";
    await streamChat({
      messages: messagesForApi.slice(1).slice(-12), // skip greeting, keep last 6 turns
      strategies: activeStrategies.map(s => ({ id: s.id, name: s.name, instructions: s.instructions })),
      model: selectedModel, temperature: temperature[0], systemPrompt, tradingMode,
      onDelta: (chunk) => {
        assistantSoFar += chunk;
        chat.upsertAssistant(assistantSoFar);
      },
      onDone: () => chat.setLoading(false),
      onError: (err) => {
        chat.upsertAssistant(`Error: ${err}`);
        chat.setLoading(false);
      },
    });
  };

  return (
    <div className="grid md:grid-cols-5 gap-6 apple-reveal">
      {/* Config */}
      <div className="md:col-span-2 space-y-4">
        <div className="rounded-2xl bg-card p-5 apple-shadow space-y-5">
          <h3 className="text-sm font-medium text-muted-foreground">Model Configuration</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">AI Model</Label>
              <button
                onClick={loadModels}
                disabled={loadingModels}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Refresh model list"
              >
                {loadingModels
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>
            <Select value={selectedModel} onValueChange={setSelectedModel}>
              <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <div className="flex flex-col gap-0.5 py-0.5">
                      <span className="flex items-center gap-1.5">
                        <Cpu className="h-3 w-3 shrink-0" />
                        <span>{m.name}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono pl-4">{m.id}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm text-muted-foreground">Temperature</Label>
              <span className="text-sm text-foreground">{temperature[0]}</span>
            </div>
            <Slider value={temperature} onValueChange={setTemperature} max={1} step={0.05} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">System Prompt</Label>
            <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} className="rounded-xl border-0 bg-secondary text-sm min-h-[100px] resize-none" />
          </div>
        </div>

        {/* Trading Mode */}
        {forcePaperMode ? (
          <div className="rounded-2xl bg-primary/5 ring-1 ring-primary/20 p-5 apple-shadow">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">Trading Mode</span>
              <Badge variant="secondary" className="text-[10px] rounded-full bg-primary/10 text-primary">Paper</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Demo mode — simulated trades only, no real money.</p>
          </div>
        ) : (
          <div className={`rounded-2xl p-5 apple-shadow transition-all duration-300 ${tradingMode === "live" ? "bg-loss/5 ring-1 ring-loss/20" : "bg-card"}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">Trading Mode</span>
                  <Badge variant="secondary" className={`text-[10px] rounded-full ${tradingMode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"}`}>
                    {tradingMode === "live" ? "Live" : "Paper"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {tradingMode === "live" ? "Real trades on Kalshi" : "Simulated -- no real money"}
                </p>
              </div>
              <Switch checked={tradingMode === "live"} onCheckedChange={(checked) => setTradingMode(checked ? "live" : "paper")} />
            </div>
            {tradingMode === "live" && (
              <div className="mt-3 flex items-start gap-2 text-xs text-loss">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                Requires Kalshi API credentials. Uses real funds. Risk limits enforced.
              </div>
            )}
          </div>
        )}

        {/* Loaded Strategies */}
        <div className="rounded-2xl bg-card p-5 apple-shadow">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-muted-foreground">Loaded Strategies</h3>
          </div>
          {activeStrategies.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active strategies.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeStrategies.map(s => (
                <Badge key={s.id} variant="secondary" className="text-[11px] rounded-full font-normal">{s.name}</Badge>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">Strategy instructions are injected into the agent's context.</p>
        </div>
      </div>

      {/* Chat */}
      <div className="md:col-span-3 rounded-2xl bg-card apple-shadow flex flex-col h-[700px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">Agent Chat</h3>
            {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
          </div>
          <Badge variant="secondary" className={`text-[10px] rounded-full ${tradingMode === "live" ? "bg-loss/10 text-loss" : "bg-primary/10 text-primary"}`}>
            {tradingMode === "live" ? "Live" : "Paper"}
          </Badge>
        </div>
        <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {chatMessages.map((msg, i) => (
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
          ))}
          <div ref={chatEndRef} />
        </div>
        <div className="px-5 py-4 border-t border-border">
          <div className="flex gap-2">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={tradingMode === "live" ? "Live mode -- tell the agent what to trade..." : "Ask the agent to analyze or trade..."}
              className="rounded-xl border-0 bg-secondary text-sm h-11"
              disabled={isLoading}
            />
            <Button size="icon" onClick={handleSend} disabled={isLoading} className="rounded-full h-11 w-11 shrink-0">
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
