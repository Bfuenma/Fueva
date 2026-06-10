exports.handler = async (event) => {
  // Handle preflight
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Webhook endpoint active' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  // ── VERIFY SIGNATURE ──────────────────────────────────────────────────────
  try {
    const sig = event.headers['stripe-signature'];
    
    // Manual signature verification without stripe npm package
    const crypto = require('crypto');
    const timestamp = sig.match(/t=(\d+)/)?.[1];
    const signatures = sig.match(/v1=([a-f0-9]+)/g)?.map(s => s.replace('v1=', ''));
    
    const payload = `${timestamp}.${event.body}`;
    const expected = crypto
      .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
      .update(payload, 'utf8')
      .digest('hex');
    
    const valid = signatures?.some(s => 
      crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex'))
    );
    
    if (!valid) {
      console.log('Invalid signature');
      return { statusCode: 400, body: 'Invalid signature' };
    }
    
    stripeEvent = JSON.parse(event.body);
  } catch (err) {
    console.log('Signature error:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Event type:', stripeEvent.type);

  // ── EXTRACT EMAIL AND PLAN ────────────────────────────────────────────────
  let email = null;
  let plan = null;
  let subscribedUntil = null;
  let stripeCustomerId = null;

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      email = session.customer_details?.email || session.customer_email;
      stripeCustomerId = session.customer;
      const amount = session.amount_total || 0;
      if (amount <= 400) plan = 'basic';
      else if (amount <= 1000) plan = 'plus';
      else plan = 'premium';

    } else if (
      stripeEvent.type === 'customer.subscription.created' ||
      stripeEvent.type === 'customer.subscription.updated'
    ) {
      const sub = stripeEvent.data.object;
      stripeCustomerId = sub.customer;

      // Get email via Stripe API
      const custRes = await fetch(
        `https://api.stripe.com/v1/customers/${stripeCustomerId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
          }
        }
      );
      const cust = await custRes.json();
      email = cust.email;

      // Determine plan from interval
      const interval = sub.items?.data?.[0]?.plan?.interval;
      if (interval === 'week') plan = 'basic';
      else if (interval === 'year') plan = 'premium';
      else plan = 'plus';

      // Set expiry from subscription
      const periodEnd = sub.items?.data?.[0]?.current_period_end;
      if (periodEnd) {
        subscribedUntil = new Date(periodEnd * 1000).toISOString();
      }

    } else if (stripeEvent.type === 'customer.subscription.deleted') {
      const sub = stripeEvent.data.object;
      stripeCustomerId = sub.customer;
      const custRes = await fetch(
        `https://api.stripe.com/v1/customers/${stripeCustomerId}`,
        { headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
      );
      const cust = await custRes.json();
      email = cust.email;
      plan = 'expired';
      subscribedUntil = new Date().toISOString();
    }
  } catch(e) {
    console.log('Event parsing error:', e.message);
  }

  // Set default expiry if not set
  if (!subscribedUntil && plan && plan !== 'expired') {
    const now = new Date();
    if (plan === 'basic') now.setDate(now.getDate() + 7);
    else if (plan === 'premium') now.setFullYear(now.getFullYear() + 1);
    else now.setMonth(now.getMonth() + 1);
    subscribedUntil = now.toISOString();
  }

  // ── UPDATE SUPABASE ───────────────────────────────────────────────────────
  if (email && plan) {
    console.log(`Activating: ${email} → ${plan} until ${subscribedUntil}`);
    
    try {
      // Try PATCH first (update existing)
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
          body: JSON.stringify({
            plan,
            subscribed_until: subscribedUntil,
            stripe_customer_id: stripeCustomerId
          })
        }
      );

      const patchText = await patchRes.text();
      console.log('PATCH result:', patchText);

      // If no existing row, INSERT new one
      if (!patchText || patchText === '[]') {
        const postRes = await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
              email,
              plan,
              subscribed_until: subscribedUntil,
              stripe_customer_id: stripeCustomerId,
              created_at: new Date().toISOString()
            })
          }
        );
        console.log('POST result:', await postRes.text());
      }

    } catch(e) {
      console.log('Supabase error:', e.message);
      return { statusCode: 500, body: 'DB error' };
    }
  } else {
    console.log('No email/plan extracted from event:', stripeEvent.type);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ received: true })
  };
};
