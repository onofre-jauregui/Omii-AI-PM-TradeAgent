import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Cpu, Send, MessageSquare, Loader2, BookOpen, AlertTriangle } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { useStrategies } from "@/lib/strategiesContext";

const MODELS = [
  { value: "gemini-flash", label: "Gemini 3 Flash", provider: "Google" },
  { value: "gemini-pro", label: "Gemini 2.5 Pro", provider: "Google" },
  { value: "gpt5", label: "GPT-5", provider: "OpenAI" },
  { value: "gpt5-mini", label: "GPT-5 Mini", provider: "OpenAI" },
];

type Msg = { role: "user" | "assistant"; content: string };

const AGENT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trading-agent`;

async function streamChat({
  messages, strategies, model, temperature, systemPrompt, tradingMode, onDelta, onDone, onError,
}: {
  messages: Msg[]; strategies: { name: string; instructions: string }[]; model: string; temperature: number; systemPrompt: string; tradingMode: string; onDelta: (text: string) => void; onDone: () => void; onError: (error: string) => void;
}) {
  const resp = await fetch(AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}` },
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

export function AgentPanel() {
  const { getActiveStrategies } = useStrategies();
  const [selectedModel, setSelectedModel] = useState("gemini-flash");
  const [temperature, setTemperature] = useState([0.3]);
  const [tradingMode, setTradingMode] = useState<"paper" | "live">("paper");
  const [systemPrompt, setSystemPrompt] = useState(
    `You are an expert algorithmic trading agent for Kalshi event contracts. Analyze market data, news sentiment, probability shifts, and order book depth to identify profitable trading opportunities. Use limit orders for better execution. Provide clear trade signals with entry/exit prices and confidence levels.`
  );
  const [chatMessages, setChatMessages] = useState<Msg[]>([
    { role: "assistant", content: "Agent ready. I can analyze Kalshi event contracts, execute limit orders, check your portfolio, and cancel open orders. Active strategies are loaded automatically.\n\nTry: **\"Go trade\"** or **\"Analyze the top markets\"** or **\"Check my portfolio\"**" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const activeStrategies = getActiveStrategies();

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const handleSend = async () => {
    if (!chatInput.trim() || isLoading) return;
    const userMsg: Msg = { role: "user", content: chatInput };
    const newMessages = [...chatMessages, userMsg];
    setChatMessages(newMessages);
    setChatInput("");
    setIsLoading(true);
    let assistantSoFar = "";
    const upsertAssistant = (chunk: string) => {
      assistantSoFar += chunk;
      setChatMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && prev.length > newMessages.length)
          return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };
    await streamChat({
      messages: newMessages.slice(1),
      strategies: activeStrategies.map(s => ({ id: s.id, name: s.name, instructions: s.instructions })),
      model: selectedModel, temperature: temperature[0], systemPrompt, tradingMode,
      onDelta: upsertAssistant,
      onDone: () => setIsLoading(false),
      onError: (err) => { setChatMessages(prev => [...prev, { role: "assistant", content: `Error: ${err}` }]); setIsLoading(false); },
    });
  };

  return (
    <div className="grid md:grid-cols-5 gap-6 apple-reveal">
      {/* Config */}
      <div className="md:col-span-2 space-y-4">
        <div className="rounded-2xl bg-card p-5 apple-shadow space-y-5">
          <h3 className="text-sm font-medium text-muted-foreground">Model Configuration</h3>
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">AI Model</Label>
            <Select value={selectedModel} onValueChange={setSelectedModel}>
              <SelectTrigger className="rounded-xl border-0 bg-secondary text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    <span className="flex items-center gap-2">
                      <Cpu className="h-3 w-3" /> {m.label}
                      <span className="text-muted-foreground text-[10px]">({m.provider})</span>
                    </span>
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
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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
