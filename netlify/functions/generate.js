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

  // Fetch all data in parallel with 4 second timeout each
  const fetchWithTimeout = (url, options = {}, ms = 4000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal })
      .then(r => r.json())
      .catch(() => null)
      .finally(() => clearTimeout(timeout));
  };

  // Run all fetches in parallel
  const [cgData, fgData, newsData] = await Promise.all([
    // CoinGecko — top 6 crypto
    fetchWithTimeout(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana,binancecoin,dogecoin&order=market_cap_desc&per_page=5&price_change_percentage=24h'
    ),
    // Fear & Greed
    fetchWithTimeout('https://api.alternative.me/fng/?limit=1'),
    // NewsAPI
    fetchWithTimeout(
      `https://newsapi.org/v2/everything?q=bitcoin+crypto+stocks+market&sortBy=publishedAt&pageSize=5&language=en&apiKey=${NEWS_API_KEY}`
    )
  ]);

  // Build compact data block
  let dataBlock = '=== LIVE MARKET DATA ===\n';

  if (Array.isArray(cgData)) {
    dataBlock += 'CRYPTO: ' + cgData.map(c =>
      `${c.symbol?.toUpperCase()} $${c.current_price?.toLocaleString()} (${c.price_change_percentage_24h >= 0 ? '+' : ''}${c.price_change_percentage_24h?.toFixed(1)}%)`
    ).join(' | ') + '\n';
  }

  if (fgData?.data?.[0]) {
    dataBlock += `FEAR & GREED: ${fgData.data[0].value}/100 ${fgData.data[0].value_classification}\n`;
  }

  if (newsData?.articles?.length > 0) {
    dataBlock += 'HEADLINES:\n' + newsData.articles.slice(0, 4).map((a, i) =>
      `${i+1}. ${a.title}`
    ).join('\n') + '\n';
  }

  dataBlock += '=== END DATA ===\n\n';

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Inject live data into prompt
  if (body.messages?.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user') {
      last.content = dataBlock + last.content;
    }
  }

  // Call Claude with 25 second timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);
    const data = await res.json();

    return {
      statusCode: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch(e) {
    clearTimeout(timeout);
    console.log('Claude error:', e.message);
    return {
      statusCode: 504,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Generation timed out. Please try again.' })
    };
  }
};
