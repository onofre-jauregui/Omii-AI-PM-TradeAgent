import { Link } from "react-router-dom";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="frosted-glass sticky top-0 z-50 border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3.5">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
              <Bot className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">TradeAgent</span>
          </Link>
          <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
            <Link to="/terms">Terms of Service →</Link>
          </Button>
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="mb-2 text-3xl font-bold text-foreground" style={{ letterSpacing: "-0.02em" }}>Privacy Policy</h1>
        <p className="mb-12 text-sm text-muted-foreground">Last updated: May 2026</p>

        <div className="space-y-10 text-sm leading-relaxed">

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">What we collect</h2>
            <ul className="space-y-2">
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Account information:</span> Your email address and a password hash (managed by Supabase Auth). We do not store plaintext passwords.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Kalshi API key:</span> Stored AES-256 encrypted. Used solely to execute trades on your behalf on the Kalshi exchange.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Trade history:</span> Records of trades executed by the agent on your behalf, stored in your account.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Strategy settings:</span> Your selected strategies, risk limits, and configuration preferences.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Agent memory:</span> Lessons and confidence scores derived from your trade outcomes. If opted in, anonymized versions of these are contributed to the shared model.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Community knowledge sharing</h2>
            <p className="text-muted-foreground mb-3">When you are opted in (the default), anonymized trade outcome signals from your activity are contributed to the platform's shared AI memory pool. What we share:</p>
            <ul className="space-y-1 mb-3 text-muted-foreground list-disc list-inside">
              <li>Win/loss outcome for each trade</li>
              <li>Confidence score assigned by the agent</li>
              <li>Market category (e.g. "economic indicator", "weather")</li>
              <li>Whether the memory was confirmed or contradicted over time</li>
            </ul>
            <p className="text-muted-foreground mb-3">What we never share:</p>
            <ul className="space-y-1 mb-3 text-muted-foreground list-disc list-inside">
              <li>Your name, email, or any account identifiers</li>
              <li>Exact position sizes or dollar amounts</li>
              <li>Your Kalshi username or account details</li>
              <li>Any data that could identify you individually</li>
            </ul>
            <p className="text-muted-foreground">You can opt out from your account settings at any time. Opting out stops future contributions and stops your account from receiving shared memory updates.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">How we use your data</h2>
            <ul className="space-y-2">
              <li className="text-muted-foreground"><span className="text-foreground font-medium">To operate the service:</span> Execute trades, display your portfolio, maintain your account.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">To improve the AI:</span> Anonymized trade signals (if opted in) are used to train and refine the shared agent memory model.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">To communicate with you:</span> Service updates, billing receipts, and security alerts. We do not send marketing emails without explicit opt-in.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Data storage and security</h2>
            <p className="text-muted-foreground mb-3">Your data is stored on Supabase (hosted on AWS). Data is encrypted in transit (TLS) and at rest. API keys are additionally encrypted at the application layer with AES-256 before database storage.</p>
            <p className="text-muted-foreground">We do not sell your data to third parties. We do not share your data with advertisers.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Third-party services</h2>
            <ul className="space-y-2">
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Kalshi:</span> Your API key is transmitted to Kalshi's API servers when trades are executed. Kalshi's own privacy policy governs data they collect.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">Supabase:</span> Database, authentication, and edge function hosting. Supabase is SOC 2 Type II certified.</li>
              <li className="text-muted-foreground"><span className="text-foreground font-medium">OpenRouter / AI providers:</span> Market analysis prompts are sent to LLM providers via OpenRouter. These prompts contain market data and strategy context — not your personal information or account details.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Your rights</h2>
            <p className="text-muted-foreground mb-3">You may request to:</p>
            <ul className="space-y-1 text-muted-foreground list-disc list-inside">
              <li>Export your account data and trade history</li>
              <li>Delete your account and all associated data</li>
              <li>Opt out of community knowledge sharing</li>
              <li>Receive a copy of what data we hold about you</li>
            </ul>
            <p className="mt-3 text-muted-foreground">Email <a href="mailto:omiiaiagency@gmail.com" className="text-primary hover:underline">omiiaiagency@gmail.com</a> for any of the above. We respond within 5 business days.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Account deletion</h2>
            <p className="text-muted-foreground">When you delete your account, your email, API key, and strategy settings are deleted immediately. Anonymized trade signal data already contributed to the shared model is retained (it cannot be attributed back to you). Your personal trade history is deleted within 30 days.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Changes to this policy</h2>
            <p className="text-muted-foreground">We will notify registered users by email before making material changes to this privacy policy. Continued use after notification constitutes acceptance.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">Contact</h2>
            <p className="text-muted-foreground">Privacy questions: <a href="mailto:omiiaiagency@gmail.com" className="text-primary hover:underline">omiiaiagency@gmail.com</a></p>
          </section>

        </div>
      </main>

      <footer className="border-t border-border px-6 py-8 mt-8">
        <div className="mx-auto max-w-3xl flex justify-between text-xs text-muted-foreground/50">
          <Link to="/" className="hover:text-foreground transition-colors">← Back to TradeAgent</Link>
          <Link to="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
        </div>
      </footer>
    </div>
  );
}
