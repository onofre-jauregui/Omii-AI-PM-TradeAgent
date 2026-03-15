export const MOCK_POSITIONS = [
  { id: "1", market: "Will Bitcoin hit $150K by Dec 2026?", side: "yes", entry: 42, current: 58, value: 580, pnl: 160, shares: 1000 },
  { id: "2", market: "US GDP growth > 3% in Q2 2026?", side: "no", entry: 65, current: 55, value: 550, pnl: 100, shares: 1000 },
  { id: "3", market: "Fed rate cut before July 2026?", side: "yes", entry: 72, current: 68, value: 680, pnl: -40, shares: 1000 },
  { id: "4", market: "Tesla stock above $400 by March 2027?", side: "yes", entry: 35, current: 41, value: 410, pnl: 60, shares: 1000 },
];

export const MOCK_MARKETS = [
  { id: "1", question: "Will Bitcoin hit $150,000 by December 2026?", yesPrice: 58, noPrice: 42, volume: 2450000, endDate: "Dec 31, 2026", category: "Crypto" },
  { id: "2", question: "Will the Fed cut rates before July 2026?", yesPrice: 68, noPrice: 32, volume: 1800000, endDate: "Jul 1, 2026", category: "Economy" },
  { id: "3", question: "US GDP growth exceeds 3% in Q2 2026?", yesPrice: 45, noPrice: 55, volume: 890000, endDate: "Jul 30, 2026", category: "Economy" },
  { id: "4", question: "Will Tesla stock be above $400 by March 2027?", yesPrice: 41, noPrice: 59, volume: 1200000, endDate: "Mar 31, 2027", category: "Stocks" },
  { id: "5", question: "Will SpaceX Starship complete orbital flight in 2026?", yesPrice: 82, noPrice: 18, volume: 3100000, endDate: "Dec 31, 2026", category: "Tech" },
  { id: "6", question: "Will Ethereum flip Bitcoin in market cap by 2027?", yesPrice: 12, noPrice: 88, volume: 950000, endDate: "Dec 31, 2027", category: "Crypto" },
  { id: "7", question: "Will AI regulation pass in the US before 2027?", yesPrice: 55, noPrice: 45, volume: 750000, endDate: "Dec 31, 2026", category: "Politics" },
  { id: "8", question: "Will global oil prices exceed $100/barrel in 2026?", yesPrice: 38, noPrice: 62, volume: 620000, endDate: "Dec 31, 2026", category: "Commodities" },
];

export const MOCK_TRADES = [
  { id: "1", market: "Will Bitcoin hit $150K by Dec 2026?", side: "buy" as const, outcome: "YES", price: 42, pnl: 160, status: "filled" as const, strategy: "Momentum", timestamp: "2026-03-15 09:32" },
  { id: "2", market: "US GDP growth > 3% in Q2 2026?", side: "buy" as const, outcome: "NO", price: 65, pnl: 100, status: "filled" as const, strategy: "Mean Reversion", timestamp: "2026-03-14 14:15" },
  { id: "3", market: "Fed rate cut before July 2026?", side: "buy" as const, outcome: "YES", price: 72, pnl: -40, status: "filled" as const, strategy: "AI Sentiment", timestamp: "2026-03-14 11:45" },
  { id: "4", market: "Tesla stock above $400 by March 2027?", side: "buy" as const, outcome: "YES", price: 35, pnl: 60, status: "filled" as const, strategy: "Momentum", timestamp: "2026-03-13 16:20" },
  { id: "5", market: "SpaceX Starship orbital flight in 2026?", side: "sell" as const, outcome: "NO", price: 18, pnl: 25, status: "filled" as const, strategy: "Arbitrage", timestamp: "2026-03-13 10:08" },
  { id: "6", market: "Ethereum flip Bitcoin market cap by 2027?", side: "buy" as const, outcome: "NO", price: 88, pnl: 0, status: "pending" as const, strategy: "AI Sentiment", timestamp: "2026-03-15 10:00" },
  { id: "7", market: "AI regulation in US before 2027?", side: "buy" as const, outcome: "YES", price: 55, pnl: 0, status: "pending" as const, strategy: "Momentum", timestamp: "2026-03-15 10:15" },
];
