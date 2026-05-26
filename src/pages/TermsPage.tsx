import { Link } from "react-router-dom";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function TermsPage() {
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
            <Link to="/privacy">Privacy Policy →</Link>
          </Button>
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="mb-2 text-3xl font-bold text-foreground" style={{ letterSpacing: "-0.02em" }}>Terms of Service</h1>
        <p className="mb-12 text-sm text-muted-foreground">Last updated: May 2026</p>

        <div className="space-y-10 text-sm leading-relaxed">

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">1. Not Financial Advice</h2>
            <p className="text-muted-foreground">TradeAgent is an automated trading tool, not a financial advisor, broker, or investment service. Nothing on this platform constitutes financial, investment, legal, or tax advice. All trading decisions are executed by software on your behalf based on strategies you select. You are solely responsible for all trading outcomes.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">2. Risk Disclosure</h2>
            <p className="text-muted-foreground mb-3">Trading prediction markets involves substantial risk of loss. You may lose some or all of the funds you allocate. Past performance — including any performance data shown on this platform — is not indicative of future results. Automated trading strategies can fail, produce losses, and behave unexpectedly under market conditions that differ from historical patterns.</p>
            <p className="text-muted-foreground">By using TradeAgent, you acknowledge that you understand and accept these risks. Only trade with funds you can afford to lose.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">3. Fund Custody</h2>
            <p className="text-muted-foreground mb-3">TradeAgent does not hold, custody, or control your funds at any time. All funds remain on the Kalshi exchange under your account. TradeAgent connects to Kalshi via an API key that grants trading permissions only. We cannot withdraw funds, transfer money, or access your Kalshi account for any purpose other than placing and closing trades as directed by your selected strategy.</p>
            <p className="text-muted-foreground">You can revoke TradeAgent's API access from your Kalshi account settings at any time. Revocation immediately stops all automated trading activity.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">4. Agent Capital Budget and Limits</h2>
            <p className="text-muted-foreground mb-3">TradeAgent allows you to configure an Agent Capital Limit — a maximum dollar amount the agent is permitted to hold in open live positions at any given time. This limit is enforced server-side before every order is submitted. If your open exposure equals or exceeds this limit, no new live orders will be placed until existing positions close.</p>
            <p className="text-muted-foreground mb-3">It is your responsibility to configure this limit appropriately before enabling live trading. The platform provides this control as a protective mechanism, but does not guarantee that it will prevent all losses. Market conditions, network failures, or Kalshi API delays may in rare cases result in orders being placed or settled outside expected parameters.</p>
            <p className="text-muted-foreground">Omii AI is not responsible for losses that occur because you configured an Agent Capital Limit that you later determined was higher than intended, or failed to configure the limit at all. You are solely responsible for setting, reviewing, and updating this parameter. We strongly recommend starting with the lowest capital limit you are comfortable risking and increasing it only after reviewing the agent's paper trading performance.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">5. API Key Security</h2>
            <p className="text-muted-foreground">Your Kalshi API key is encrypted using AES-256 encryption at rest. We do not log, display, or transmit your API key in plaintext. The key is decrypted only at the moment a trade is executed and is immediately discarded from memory afterward.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">6. Community Knowledge Sharing</h2>
            <p className="text-muted-foreground mb-3">By default, users are opted in to contribute anonymized trade outcome data (win/loss signals, confidence scores, market categories) to the shared AI memory pool. This data does not include your name, account information, exact position sizes, or any personally identifiable information.</p>
            <p className="text-muted-foreground mb-3">Contributed data is used to improve the platform's AI trading models for all opted-in users. High-confidence lessons may be promoted to the platform-wide memory pool after automated validation.</p>
            <p className="text-muted-foreground">You may opt out of community knowledge sharing at any time from your account settings. Opted-out users trade using only their own trade history and do not receive updates from the platform memory pool.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">7. Paper Trading</h2>
            <p className="text-muted-foreground">Paper trading mode simulates trades against live Kalshi market prices without placing real orders. No real money is used in paper mode. Paper trading results do not guarantee equivalent results in live trading. Market conditions, liquidity, and execution timing may differ between paper and live environments.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">8. Platform Availability</h2>
            <p className="text-muted-foreground">We do not guarantee uninterrupted availability of the platform. Scheduled maintenance, unexpected outages, or third-party service failures (including Kalshi API downtime) may prevent trade execution. We are not liable for losses resulting from platform unavailability.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">9. Limitation of Liability</h2>
            <p className="text-muted-foreground mb-3">To the maximum extent permitted by law, Omii AI and its operators are not liable for any trading losses, lost profits, or indirect, incidental, consequential, or special damages of any kind arising from your use of TradeAgent. This includes, without limitation: losses from automated trades placed by the agent on your behalf, losses resulting from misconfigured capital limits or risk settings, losses caused by Kalshi API failures or market illiquidity, losses resulting from AI model errors or unexpected strategy behavior, and losses that occur during platform outages or maintenance windows.</p>
            <p className="text-muted-foreground mb-3">You expressly acknowledge that you are using an automated trading system and that automated systems can behave unexpectedly. You accept full responsibility for all trading outcomes, including losses that exceed any limits you configured. Our platform controls (capital limits, stop-losses, position size caps) are best-effort protections — they do not guarantee that losses will not occur or will be limited to configured thresholds.</p>
            <p className="text-muted-foreground">Our total aggregate liability to you for any claim is limited to the amount you paid us in subscription fees in the 30 days prior to the claim. If you have not paid any subscription fees, our total liability is limited to $10.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">10. Account Termination</h2>
            <p className="text-muted-foreground">We reserve the right to suspend or terminate accounts that violate these terms, engage in abusive behavior, or attempt to misuse the platform's API access. Upon termination, your API key data is deleted from our systems within 30 days.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">11. Changes to These Terms</h2>
            <p className="text-muted-foreground">We may update these terms from time to time. Continued use of TradeAgent after changes are posted constitutes acceptance of the updated terms. Material changes will be communicated via email to registered users.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-foreground">12. Contact</h2>
            <p className="text-muted-foreground">Questions about these terms: <a href="mailto:omiiaiagency@gmail.com" className="text-primary hover:underline">omiiaiagency@gmail.com</a></p>
          </section>

        </div>
      </main>

      <footer className="border-t border-border px-6 py-8 mt-8">
        <div className="mx-auto max-w-3xl flex justify-between text-xs text-muted-foreground/50">
          <Link to="/" className="hover:text-foreground transition-colors">← Back to TradeAgent</Link>
          <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
        </div>
      </footer>
    </div>
  );
}
