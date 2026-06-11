const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const custRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email.trim().toLowerCase())}&limit=5`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
    );
    const custData = await custRes.json();

    if (!custData.data?.length) {
      return res.json({ status: 'not_found', message: 'No Stripe account found for this email.' });
    }

    let activeSub = null;
    let customerId = null;

    for (const customer of custData.data) {
      const subRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${customer.id}&limit=10`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      const subData = await subRes.json();
      const sub = subData.data?.find(s => ['active','trialing','past_due'].includes(s.status));
      if (sub) { activeSub = sub; customerId = customer.id; break; }
      if (!activeSub && subData.data?.length) { activeSub = subData.data[0]; customerId = customer.id; }
    }

    if (!activeSub) {
      return res.json({ status: 'no_subscription', message: 'Payment not confirmed yet. Wait 30 seconds and try again.' });
    }

    const interval = activeSub.items?.data?.[0]?.plan?.interval;
    const plan = interval === 'week' ? 'basic' : interval === 'year' ? 'premium' : 'plus';
    const periodEnd = activeSub.items?.data?.[0]?.current_period_end;
    const subscribedUntil = periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ plan, subscribed_until: subscribedUntil, stripe_customer_id: customerId })
      }
    );

    const patchText = await patchRes.text();
    if (!patchText || patchText === '[]') {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ email, plan, subscribed_until: subscribedUntil, stripe_customer_id: customerId, created_at: new Date().toISOString() })
      });
    }

    return res.json({ status: 'activated', plan, subscribedUntil });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { maxDuration: 30 };
