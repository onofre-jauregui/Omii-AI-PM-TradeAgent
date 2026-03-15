import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Brain, Cpu, Send, MessageSquare, Settings, Loader2, BookOpen, AlertTriangle } from "lucide-react";
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
  messages,
  strategies,
  model,
  temperature,
  systemPrompt,
  tradingMode,
  onDelta,
  onDone,
  onError,
}: {
  messages: Msg[];
  strategies: { name: string; instructions: string }[];
  model: string;
  temperature: number;
  systemPrompt: string;
  tradingMode: string;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}) {
  const resp = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ messages, strategies, model, temperature, systemPrompt, tradingMode }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Unknown error" }));
    onError(err.error || `Error ${resp.status}`);
    return;
  }

  if (!resp.body) { onError("No response body"); return; }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith(":") || line.trim() === "") continue;
      if (!line.startsWith("data: ")) continue;

      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") { done = true; break; }

      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content as string | undefined;
        if (content) onDelta(content);
      } catch {
        buffer = line + "\n" + buffer;
        break;
      }
    }
  }

  if (buffer.trim()) {
    for (let raw of buffer.split("\n")) {
      if (!raw) continue;
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (!raw.startsWith("data: ")) continue;
      const jsonStr = raw.slice(6).trim();
      if (jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content as string | undefined;
        if (content) onDelta(content);
      } catch { /* ignore */ }
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
    `You are an expert algorithmic trading agent for prediction markets (Polymarket). Analyze market data, news sentiment, and probability shifts to identify profitable trading opportunities. Consider:\n- Market liquidity and volume\n- Historical price patterns\n- News catalysts and timing\n- Risk/reward ratios\n- Correlation with other markets\n\nProvide clear trade signals with entry/exit prices and confidence levels.`
  );
  const [chatMessages, setChatMessages] = useState<Msg[]>([
    { role: "assistant", content: "🤖 Agent ready. I can analyze markets, execute trades, and explain my reasoning. Active strategies are loaded automatically.\n\nTry saying: **\"Go trade\"** or **\"Analyze the top markets and find opportunities\"**" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const activeStrategies = getActiveStrategies();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

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
        if (last?.role === "assistant" && prev.length > newMessages.length) {
          return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantSoFar } : m);
        }
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };

    await streamChat({
      messages: newMessages.slice(1), // skip initial greeting
      strategies: activeStrategies.map(s => ({ name: s.name, instructions: s.instructions })),
      model: selectedModel,
      temperature: temperature[0],
      systemPrompt,
      tradingMode,
      onDelta: upsertAssistant,
      onDone: () => setIsLoading(false),
      onError: (err) => {
        setChatMessages(prev => [...prev, { role: "assistant", content: `❌ Error: ${err}` }]);
        setIsLoading(false);
      },
    });
  };

  return (
    <div className="grid md:grid-cols-2 gap-6 animate-slide-up">
      {/* Config Panel */}
      <div className="space-y-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <Settings className="h-4 w-4" /> MODEL CONFIGURATION
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground">AI MODEL</Label>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="bg-secondary border-border font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      <span className="flex items-center gap-2">
                        <Cpu className="h-3 w-3" />
                        {m.label}
                        <span className="text-muted-foreground text-[10px]">({m.provider})</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-mono text-muted-foreground">TEMPERATURE</Label>
                <span className="text-xs font-mono text-foreground">{temperature[0]}</span>
              </div>
              <Slider value={temperature} onValueChange={setTemperature} max={1} step={0.05} className="w-full" />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground">SYSTEM PROMPT</Label>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                className="bg-secondary border-border font-mono text-xs min-h-[100px] resize-none"
              />
            </div>
          </CardContent>
        </Card>

        {/* Trading Mode */}
        <Card className={`bg-card border-border ${tradingMode === "live" ? "border-loss/50" : "border-primary/30"}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-mono font-semibold">TRADING MODE</Label>
                  <Badge
                    variant="outline"
                    className={`text-[10px] font-mono ${tradingMode === "live" ? "border-loss/50 text-loss" : "border-primary/50 text-primary"}`}
                  >
                    {tradingMode === "live" ? "🔴 LIVE" : "📝 PAPER"}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {tradingMode === "live"
                    ? "Real trades will be executed on Polymarket"
                    : "Simulated trades — no real money at risk"}
                </p>
              </div>
              <Switch
                checked={tradingMode === "live"}
                onCheckedChange={(checked) => setTradingMode(checked ? "live" : "paper")}
              />
            </div>
            {tradingMode === "live" && (
              <div className="mt-3 p-2 rounded-md bg-loss/10 border border-loss/20 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-loss shrink-0 mt-0.5" />
                <p className="text-[10px] text-loss font-mono">
                  CAUTION: Live mode requires Polymarket API credentials configured in Settings. Trades use real funds.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active Strategies */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <BookOpen className="h-4 w-4" /> LOADED STRATEGIES
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeStrategies.length === 0 ? (
              <p className="text-xs text-muted-foreground font-mono">No active strategies. Enable them in the Strategies tab.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activeStrategies.map(s => (
                  <Badge key={s.id} variant="outline" className="font-mono text-[10px] border-primary/50 text-primary">
                    {s.name}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2">
              Active strategy instructions are injected into the agent's context when trading.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Chat Panel */}
      <Card className="bg-card border-border flex flex-col h-[700px]">
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex items-center justify-between">
            <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
              <MessageSquare className="h-4 w-4" /> AGENT CHAT
              {isLoading && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
            </CardTitle>
            <Badge
              variant="outline"
              className={`text-[10px] font-mono ${tradingMode === "live" ? "border-loss/50 text-loss" : "border-primary/50 text-primary"}`}
            >
              {tradingMode === "live" ? "🔴 LIVE" : "📝 PAPER"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
          {chatMessages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
                msg.role === "user"
                  ? "bg-primary/20 text-foreground"
                  : "bg-secondary text-foreground"
              }`}>
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_code]:text-xs [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  msg.content
                )}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </CardContent>
        <div className="p-4 border-t border-border">
          <div className="flex gap-2">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={tradingMode === "live" ? "⚠️ Live mode — tell the agent what to trade..." : "Tell the agent to analyze or trade..."}
              className="bg-secondary border-border font-mono text-sm"
              disabled={isLoading}
            />
            <Button size="icon" onClick={handleSend} className="shrink-0" disabled={isLoading}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
