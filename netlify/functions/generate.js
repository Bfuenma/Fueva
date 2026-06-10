exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const NEWS_API_KEY = process.env.NEWS_API_KEY || '23d89b848f6e4a75a2925e56d5fba451';

  // ── 1. COINGECKO — Live crypto prices ────────────────────────────────────
  let cryptoData = '';
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana,binancecoin,dogecoin,shiba-inu&order=market_cap_desc&per_page=6&price_change_percentage=24h'
    );
    const d = await r.json();
    if (Array.isArray(d)) {
      cryptoData = d.map(c =>
        `${c.symbol.toUpperCase()}: $${c.current_price?.toLocaleString()} (${c.price_change_percentage_24h >= 0 ? '+' : ''}${c.price_change_percentage_24h?.toFixed(2)}% 24h | MCap $${(c.market_cap/1e9).toFixed(1)}B | Vol $${(c.total_volume/1e9).toFixed(1)}B)`
      ).join('\n');
    }
  } catch(e) { cryptoData = 'Unavailable'; }

  // ── 2. COINGECKO — Trending coins ────────────────────────────────────────
  let trendingData = '';
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/search/trending');
    const d = await r.json();
    if (d.coins) {
      trendingData = d.coins.slice(0, 5).map((c, i) =>
        `${i+1}. ${c.item.name} (${c.item.symbol.toUpperCase()})`
      ).join(', ');
    }
  } catch(e) { trendingData = 'Unavailable'; }

  // ── 3. YAHOO FINANCE — Stock prices ──────────────────────────────────────
  let stockData = '';
  try {
    const syms = ['AAPL','NVDA','SPY','QQQ','TSLA','MSFT'];
    const results = await Promise.all(syms.map(sym =>
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`)
        .then(r => r.json())
        .then(d => {
          const m = d?.chart?.result?.[0]?.meta;
          if (!m) return null;
          const p = m.regularMarketPrice;
          const prev = m.chartPreviousClose || p;
          const chg = ((p - prev) / prev * 100).toFixed(2);
          return `${sym}: $${p.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg}%)`;
        }).catch(() => null)
    ));
    stockData = results.filter(Boolean).join(' | ');
  } catch(e) { stockData = 'Unavailable'; }

  // ── 4. FEAR & GREED INDEX ─────────────────────────────────────────────────
  let fearGreed = '';
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    if (d.data?.[0]) {
      fearGreed = `${d.data[0].value}/100 — ${d.data[0].value_classification}`;
    }
  } catch(e) { fearGreed = 'Unavailable'; }

  // ── 5. NEWSAPI — Today's headlines ───────────────────────────────────────
  let newsData = '';
  try {
    const r = await fetch(
      `https://newsapi.org/v2/everything?q=(crypto OR bitcoin OR stocks OR "stock market" OR "federal reserve" OR DeFi OR ethereum)&sortBy=publishedAt&pageSize=10&language=en&apiKey=${NEWS_API_KEY}`
    );
    const d = await r.json();
    if (d.articles?.length > 0) {
      newsData = d.articles.slice(0, 8).map((a, i) =>
        `${i+1}. [${a.source.name}] ${a.title}`
      ).join('\n');
    }
  } catch(e) { newsData = 'Unavailable'; }

  // ── 6. INJECT LIVE DATA INTO PROMPT ──────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  if (body.messages?.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user') {
      const liveBlock = `
=== LIVE MARKET DATA — ${new Date().toUTCString()} ===

CRYPTO PRICES (CoinGecko live):
${cryptoData}

TRENDING COINS RIGHT NOW:
${trendingData}

STOCK PRICES (Yahoo Finance live):
${stockData}

FEAR & GREED INDEX (alternative.me):
${fearGreed}

TODAY'S TOP FINANCIAL HEADLINES (NewsAPI):
${newsData}

=== END LIVE DATA ===

IMPORTANT: Use the live data above to ground every insight in what is actually happening in markets today. Reference specific prices, percentage moves, and headlines where relevant. Do not invent data — only use what is provided above plus your training knowledge for context.

`;
      last.content = liveBlock + last.content;
    }
  }

  // ── 7. CALL CLAUDE ────────────────────────────────────────────────────────
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  return {
    statusCode: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(data)
  };
};
