// Fallback mock data when Kalshi API is unavailable

export const MOCK_MARKETS = [
  { id: "KXBTC-26DEC31-T150000", question: "Will Bitcoin hit $150,000 by December 2026?", yesPrice: 58, noPrice: 42, volume: 2450000, endDate: "Dec 31, 2026", category: "Crypto" },
  { id: "KXFED-26JUL-RATECUT", question: "Will the Fed cut rates before July 2026?", yesPrice: 68, noPrice: 32, volume: 1800000, endDate: "Jul 1, 2026", category: "Economics" },
  { id: "KXGDP-26Q2-GT3", question: "US GDP growth exceeds 3% in Q2 2026?", yesPrice: 45, noPrice: 55, volume: 890000, endDate: "Jul 30, 2026", category: "Economics" },
  { id: "KXTSLA-27MAR-GT400", question: "Will Tesla stock be above $400 by March 2027?", yesPrice: 41, noPrice: 59, volume: 1200000, endDate: "Mar 31, 2027", category: "Financials" },
  { id: "KXSPACEX-26-ORBITAL", question: "Will SpaceX Starship complete orbital flight in 2026?", yesPrice: 82, noPrice: 18, volume: 3100000, endDate: "Dec 31, 2026", category: "Tech" },
  { id: "KXETH-27-FLIPBTC", question: "Will Ethereum flip Bitcoin in market cap by 2027?", yesPrice: 12, noPrice: 88, volume: 950000, endDate: "Dec 31, 2027", category: "Crypto" },
  { id: "KXAIREG-26-USPASS", question: "Will AI regulation pass in the US before 2027?", yesPrice: 55, noPrice: 45, volume: 750000, endDate: "Dec 31, 2026", category: "Politics" },
  { id: "KXOIL-26-GT100", question: "Will global oil prices exceed $100/barrel in 2026?", yesPrice: 38, noPrice: 62, volume: 620000, endDate: "Dec 31, 2026", category: "Commodities" },
];
