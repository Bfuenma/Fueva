exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  let email;
  try {
    const body = JSON.parse(event.body);
    email = body.email?.trim().toLowerCase();
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };

  try {
    // ── SEARCH STRIPE CUSTOMERS BY EMAIL ─────────────────────────────────
    const custRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=5`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
    );
    const custData = await custRes.json();
    console.log('Customers found:', custData.data?.length, 'for email:', email);

    if (!custData.data || custData.data.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ 
        status: 'not_found', 
        message: 'No Stripe account found for this email. Make sure you used the same email when paying.' 
      })};
    }

    // Check all customers with this email for active subscription
    let activeSub = null;
    let customerId = null;

    for (const customer of custData.data) {
      const subRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${customer.id}&limit=10`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      const subData = await subRes.json();
      console.log('Subs for customer', customer.id, ':', subData.data?.length);

      // Find any active, trialing, or past_due subscription
      const sub = subData.data?.find(s => 
        ['active', 'trialing', 'past_due'].includes(s.status)
      );

      if (sub) {
        activeSub = sub;
        customerId = customer.id;
        break;
      }

      // Also accept the most recent subscription even if status is incomplete
      if (!activeSub && subData.data?.length > 0) {
        activeSub = subData.data[0];
        customerId = customer.id;
      }
    }

    if (!activeSub) {
      return { statusCode: 200, headers, body: JSON.stringify({ 
        status: 'no_subscription', 
        message: 'Payment found but subscription not active yet. Wait 30 seconds and tap Try Again.' 
      })};
    }

    console.log('Found subscription:', activeSub.id, 'status:', activeSub.status);

    // ── DETERMINE PLAN ────────────────────────────────────────────────────
    const interval = activeSub.items?.data?.[0]?.plan?.interval;
    let plan = 'plus';
    if (interval === 'week') plan = 'basic';
    else if (interval === 'year') plan = 'premium';

    const periodEnd = activeSub.items?.data?.[0]?.current_period_end;
    const subscribedUntil = periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // ── UPDATE SUPABASE ───────────────────────────────────────────────────
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
          stripe_customer_id: customerId
        })
      }
    );

    const patchText = await patchRes.text();
    console.log('Supabase PATCH:', patchText);

    // Insert if no existing row
    if (!patchText || patchText === '[]') {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
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
          stripe_customer_id: customerId,
          created_at: new Date().toISOString()
        })
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'activated', plan, subscribedUntil })
    };

  } catch(e) {
    console.log('Error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
