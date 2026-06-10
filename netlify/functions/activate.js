// netlify/functions/activate.js
// Called by the frontend after payment — checks Stripe and activates account

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
    // ── 1. SEARCH STRIPE FOR THIS EMAIL ────────────────────────────────────
    const custRes = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:"${email}"&limit=1`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
    );
    const custData = await custRes.json();

    if (!custData.data || custData.data.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_found', message: 'No payment found for this email. Please complete payment first.' }) };
    }

    const customer = custData.data[0];
    const customerId = customer.id;

    // ── 2. GET ACTIVE SUBSCRIPTIONS ─────────────────────────────────────────
    const subRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`,
      { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
    );
    const subData = await subRes.json();

    if (!subData.data || subData.data.length === 0) {
      // Check for incomplete/trialing
      const subRes2 = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${customerId}&limit=1`,
        { headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` } }
      );
      const subData2 = await subRes2.json();
      if (!subData2.data || subData2.data.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'no_subscription', message: 'No active subscription found. Please complete payment.' }) };
      }
    }

    const sub = (subData.data && subData.data.length > 0) ? subData.data[0] : null;
    if (!sub) {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'no_subscription', message: 'Payment not confirmed yet. Please wait a moment and try again.' }) };
    }

    // ── 3. DETERMINE PLAN ───────────────────────────────────────────────────
    const interval = sub.items?.data?.[0]?.plan?.interval;
    let plan = 'plus';
    if (interval === 'week') plan = 'basic';
    else if (interval === 'year') plan = 'premium';

    const periodEnd = sub.items?.data?.[0]?.current_period_end;
    const subscribedUntil = periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // ── 4. UPDATE SUPABASE ──────────────────────────────────────────────────
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

    // If no existing row, create one
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
    console.log('Activate error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
