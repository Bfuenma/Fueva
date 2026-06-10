const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'OK' };
  }

  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  // ── VERIFY STRIPE SIGNATURE ───────────────────────────────────────────────
  let stripeEvent;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = event.headers['stripe-signature'];
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Stripe event received:', stripeEvent.type);

  // ── HANDLE EVENTS ─────────────────────────────────────────────────────────
  let email = null;
  let plan = null;
  let subscribedUntil = null;
  let stripeCustomerId = null;

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    email = session.customer_details?.email || session.customer_email;
    stripeCustomerId = session.customer;

    // Determine plan from amount
    const amount = session.amount_total;
    if (amount <= 400) plan = 'basic';
    else if (amount <= 1000) plan = 'plus';
    else plan = 'premium';

    // Set expiry based on plan
    const now = new Date();
    if (plan === 'basic') {
      now.setDate(now.getDate() + 7);
    } else if (plan === 'plus') {
      now.setMonth(now.getMonth() + 1);
    } else {
      now.setFullYear(now.getFullYear() + 1);
    }
    subscribedUntil = now.toISOString();

  } else if (stripeEvent.type === 'customer.subscription.created' || 
             stripeEvent.type === 'customer.subscription.updated') {
    const sub = stripeEvent.data.object;
    stripeCustomerId = sub.customer;

    // Get email from customer ID
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      email = customer.email;
    } catch(e) {
      console.log('Could not retrieve customer:', e.message);
    }

    // Determine plan from price amount
    const item = sub.items?.data?.[0];
    const unitAmount = item?.price?.unit_amount || 0;
    if (unitAmount <= 400) plan = 'basic';
    else if (unitAmount <= 1000) plan = 'plus';
    else plan = 'premium';

    // Set expiry from subscription period
    if (sub.current_period_end) {
      subscribedUntil = new Date(sub.current_period_end * 1000).toISOString();
    } else {
      const now = new Date();
      now.setMonth(now.getMonth() + 1);
      subscribedUntil = now.toISOString();
    }

  } else if (stripeEvent.type === 'customer.subscription.deleted') {
    const sub = stripeEvent.data.object;
    stripeCustomerId = sub.customer;
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      email = customer.email;
    } catch(e) {}
    plan = 'expired';
    subscribedUntil = new Date().toISOString();
  }

  // ── UPDATE SUPABASE ───────────────────────────────────────────────────────
  if (email && plan) {
    try {
      const updateData = {
        plan,
        subscribed_until: subscribedUntil,
      };
      if (stripeCustomerId) updateData.stripe_customer_id = stripeCustomerId;

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(updateData)
        }
      );

      const result = await res.text();
      console.log(`Updated ${email} to plan=${plan}, result:`, result);

      // If no row was updated (new customer not pre-registered), insert them
      if (result === '[]' || result === '') {
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
            stripe_customer_id: stripeCustomerId,
            created_at: new Date().toISOString()
          })
        });
        console.log(`Inserted new subscriber: ${email}`);
      }

    } catch(e) {
      console.log('Supabase update failed:', e.message);
      return { statusCode: 500, body: 'Database update failed' };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
