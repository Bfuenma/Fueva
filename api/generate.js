const NEWS_API_KEY = process.env.NEWS_API_KEY || '23d89b848f6e4a75a2925e56d5fba451';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const fetchSafe = (url) =>
    fetch(url).then(r => r.json()).catch(() => null);

  const [crypto, fg, news] = await Promise.all([
    fetchSafe('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana,binancecoin,dogecoin&order=market_cap_desc&per_page=5&price_change_percentage=24h'),
    fetchSafe('https://api.alternative.me/fng/?limit=1'),
    fetchSafe(`https://newsapi.org/v2/everything?q=bitcoin+crypto+stocks+market&sortBy=publishedAt&pageSize=4&language=en&apiKey=${NEWS_API_KEY}`)
  ]);

  let liveData = '=== LIVE MARKET DATA ===\n';
  if (Array.isArray(crypto)) {
    liveData += 'CRYPTO: ' + crypto.map(c =>
      `${c.symbol?.toUpperCase()} $${c.current_price?.toLocaleString()} (${c.price_change_percentage_24h >= 0 ? '+' : ''}${c.price_change_percentage_24h?.toFixed(1)}%)`
    ).join(' | ') + '\n';
  }
  if (fg?.data?.[0]) liveData += `FEAR/GREED: ${fg.data[0].value}/100 ${fg.data[0].value_classification}\n`;
  if (news?.articles?.length) {
    liveData += 'NEWS:\n' + news.articles.slice(0, 4).map((a, i) => `${i+1}. ${a.title}`).join('\n') + '\n';
  }
  liveData += '=== END ===\n\n';

  const body = req.body;
  if (body.messages?.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user') last.content = liveData + last.content;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  return res.status(response.status).json(data);
}

export const config = { maxDuration: 60 };
