import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.WEBHOOK_CHAOS_SECRET ?? 'test-signing-secret';
const PORT = Number(process.env.PORT ?? 3000);
const GUARDED = process.argv.includes('--guarded');

const orders = new Map();
const seenWebhookIds = new Set();

function signatureIsValid(raw, header) {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(createHmac('sha256', SECRET).update(raw).digest('base64'));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function apply(topic, payload) {
  const current = orders.get(payload.id);

  if (GUARDED && current && Date.parse(payload.updated_at) < Date.parse(current.updatedAt)) {
    return 'ignored: older than stored state';
  }

  orders.set(payload.id, {
    updatedAt: payload.updated_at,
    financialStatus: payload.financial_status,
    cancelledAt: payload.cancelled_at,
    lastTopic: topic,
  });

  return 'applied';
}

const server = createServer((request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(Object.fromEntries(orders), null, 2));
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks);
    const topic = request.headers['x-shopify-topic'];
    const webhookId = request.headers['x-shopify-webhook-id'];

    if (!signatureIsValid(raw, request.headers['x-shopify-hmac-sha256'])) {
      console.log(`  ${topic}  rejected: bad signature`);
      response.writeHead(401).end('bad signature');
      return;
    }

    if (GUARDED && seenWebhookIds.has(webhookId)) {
      console.log(`  ${topic}  ignored: webhook id already processed`);
      response.writeHead(200).end('ok');
      return;
    }
    seenWebhookIds.add(webhookId);

    const outcome = apply(topic, JSON.parse(raw.toString('utf8')));
    console.log(`  ${topic}  ${outcome}`);
    response.writeHead(200).end('ok');
  });
});

server.listen(PORT, () => {
  console.log(`naive shopify app on http://localhost:${PORT}  (${GUARDED ? 'guarded' : 'unguarded'})`);
});
