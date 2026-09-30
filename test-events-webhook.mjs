import { readFileSync } from 'fs';
import { createHmac } from 'crypto';
const envLines = readFileSync('.env', 'utf8').split('\n');
const get = (k) => (envLines.find((l) => l.startsWith(k + '=')) || '').split('=').slice(1).join('=').trim();
const whsec = get('STRIPE_WEBHOOK_SECRET');
const send = async (type, subId) => {
  const payload = JSON.stringify({ id: 'evt_teste_' + type, type, data: { object: { id: subId } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', whsec).update(ts + '.' + payload).digest('hex');
  const res = await fetch('http://localhost:3001/api/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=' + ts + ',v1=' + sig },
    body: payload,
  });
  return res.status;
};
console.log('paused ->', await send('customer.subscription.paused', 'sub_bakalover_teste'));
