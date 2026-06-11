const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const sig = req.headers['stripe-signature'];
  const crypto = require('crypto');

  let stripeEvent;
  try {
    const timestamp = sig.match(/t=(\d+)/)?.[1];
    const signatures = sig.match(/v1=([a-f0-9]+)/g)?.map(s => s.replace('v1=',''));
    const payload = `${timestamp}.${JSON.stringify(req.body)}`;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload,'utf8').digest('hex');
    const valid = signatures?.some(s => {
      try { return crypto.timingSafeEqual(Buffer.from(s,'hex'), Buffer.from(expected,'hex')); } catch(e) { return false; }
    });
    if (!valid) return res.status(400).send('Invalid signature');
    stripeEvent = req.body;
  } catch(e) {
    return res.status(400).send('Webhook error: ' + e.message);
  }

  let email = null, plan = null, subscribedUntil = null, customerId = null;

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const s = stripeEvent.data.object;
      email = s.customer_details?.email || s.customer_email;
      customerId = s.customer;
      const amount = s.amount_total || 0;
      plan = amount <= 400 ? 'basic' : amount <= 1000 ? 'plus' : 'premium';
    } else if (['customer.subscription.created','customer.subscription.updated'].includes(stripeEvent.type)) {
      const sub = stripeEvent.data.object;
      customerId = sub.customer;
      const custRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } });
      const cust = await custRes.json();
      email = cust.email;
      const interval = sub.items?.data?.[0]?.plan?.interval;
      plan = interval === 'week' ? 'basic' : interval === 'year' ? 'premium' : 'plus';
      const periodEnd = sub.items?.data?.[0]?.current_period_end;
      subscribedUntil = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
    } else if (stripeEvent.type === 'customer.subscription.deleted') {
      const sub = stripeEvent.data.object;
      customerId = sub.customer;
      const custRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } });
      const cust = await custRes.json();
      email = cust.email;
      plan = 'expired';
      subscribedUntil = new Date().toISOString();
    }
  } catch(e) { console.log('Parse error:', e.message); }

  if (!subscribedUntil && plan && plan !== 'expired') {
    const now = new Date();
    if (plan === 'basic') now.setDate(now.getDate() + 7);
    else if (plan === 'premium') now.setFullYear(now.getFullYear() + 1);
    else now.setMonth(now.getMonth() + 1);
    subscribedUntil = now.toISOString();
  }

  if (email && plan) {
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ plan, subscribed_until: subscribedUntil, stripe_customer_id: customerId })
      }
    );
    const patchText = await patchRes.text();
    if (!patchText || patchText === '[]') {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ email, plan, subscribed_until: subscribedUntil, stripe_customer_id: customerId, created_at: new Date().toISOString() })
      });
    }
    console.log('Activated:', email, plan);
  }

  return res.json({ received: true });
}

export const config = { maxDuration: 30 };
