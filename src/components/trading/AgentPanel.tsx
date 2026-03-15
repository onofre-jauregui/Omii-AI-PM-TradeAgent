import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Brain, Cpu, Send, MessageSquare, Settings } from "lucide-react";
import { useState } from "react";

const MODELS = [
  { value: "gemini-flash", label: "Gemini 3 Flash", provider: "Google" },
  { value: "gemini-pro", label: "Gemini 2.5 Pro", provider: "Google" },
  { value: "gpt5", label: "GPT-5", provider: "OpenAI" },
  { value: "gpt5-mini", label: "GPT-5 Mini", provider: "OpenAI" },
];

export function AgentPanel() {
  const [selectedModel, setSelectedModel] = useState("gemini-flash");
  const [temperature, setTemperature] = useState([0.3]);
  const [systemPrompt, setSystemPrompt] = useState(
    `You are an expert algorithmic trading agent for prediction markets. Analyze market data, news sentiment, and probability shifts to identify profitable trading opportunities. Consider:\n- Market liquidity and volume\n- Historical price patterns\n- News catalysts and timing\n- Risk/reward ratios\n- Correlation with other markets\n\nProvide clear trade signals with entry/exit prices and confidence levels.`
  );
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([
    { role: "assistant", content: "🤖 Agent ready. I can analyze markets, suggest trades, and explain my reasoning. What would you like to explore?" },
  ]);
  const [chatInput, setChatInput] = useState("");

  const handleSend = () => {
    if (!chatInput.trim()) return;
    setChatMessages(prev => [
      ...prev,
      { role: "user", content: chatInput },
      { role: "assistant", content: "⏳ AI agent integration will be connected via Lovable Cloud edge functions. Configure your model and system prompt, then connect to start receiving real-time analysis." },
    ]);
    setChatInput("");
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
              <p className="text-[10px] text-muted-foreground">Lower = more deterministic, Higher = more creative</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground">SYSTEM PROMPT</Label>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                className="bg-secondary border-border font-mono text-xs min-h-[160px] resize-none"
              />
            </div>

            <Button className="w-full font-mono text-xs gap-2">
              <Brain className="h-4 w-4" /> SAVE & DEPLOY AGENT
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Chat Panel */}
      <Card className="bg-card border-border flex flex-col h-[600px]">
        <CardHeader className="pb-3 border-b border-border">
          <CardTitle className="font-mono text-sm text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> AGENT CHAT
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
          {chatMessages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
                msg.role === "user"
                  ? "bg-primary/20 text-foreground"
                  : "bg-secondary text-foreground"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
        </CardContent>
        <div className="p-4 border-t border-border">
          <div className="flex gap-2">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Ask the agent..."
              className="bg-secondary border-border font-mono text-sm"
            />
            <Button size="icon" onClick={handleSend} className="shrink-0">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
