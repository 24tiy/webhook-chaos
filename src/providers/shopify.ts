import { createHmac } from 'node:crypto';
import type { OutgoingRequest, Provider, SignInput } from './types.js';

const TOPIC_HEADER = 'x-shopify-topic';
const WEBHOOK_ID_HEADER = 'x-shopify-webhook-id';
const SHOP_DOMAIN_HEADER = 'x-shopify-shop-domain';
const API_VERSION_HEADER = 'x-shopify-api-version';

const DEFAULT_SHOP_DOMAIN = 'webhook-chaos.myshopify.com';
const DEFAULT_API_VERSION = '2025-07';

export function shopifyHmac(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

export const shopify: Provider = {
  name: 'shopify',

  anchorFields: ['updated_at', 'created_at', 'processed_at', 'occurred_at'],

  sensitiveKeys: [
    'email',
    'contact_email',
    'phone',
    'customer',
    'billing_address',
    'shipping_address',
    'default_address',
    'note',
    'note_attributes',
    'client_details',
    'browser_ip',
    'order_status_url',
    'checkout_token',
    'cart_token',
    'token',
    'landing_site',
    'referring_site',
    'payment_details',
    'destination',
  ],

  retryOffsetsMs: [0, 300_000, 900_000, 2_100_000, 4_500_000, 8_100_000, 11_700_000, 14_400_000],

  signatureHeader: 'x-shopify-hmac-sha256',

  carriedHeaders: [TOPIC_HEADER, SHOP_DOMAIN_HEADER, API_VERSION_HEADER],

  topicOf(headers) {
    return headers[TOPIC_HEADER] ?? null;
  },

  webhookIdOf(headers) {
    return headers[WEBHOOK_ID_HEADER] ?? null;
  },

  build({ body, secret, webhookId, topic, eventTime, recordedHeaders }: SignInput): OutgoingRequest {
    return {
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Shopify-Captain-Hook',
        [TOPIC_HEADER]: topic,
        [SHOP_DOMAIN_HEADER]: recordedHeaders[SHOP_DOMAIN_HEADER] ?? DEFAULT_SHOP_DOMAIN,
        [API_VERSION_HEADER]: recordedHeaders[API_VERSION_HEADER] ?? DEFAULT_API_VERSION,
        [WEBHOOK_ID_HEADER]: webhookId,
        'x-shopify-triggered-at': eventTime.toISOString(),
        'x-shopify-hmac-sha256': shopifyHmac(body, secret),
      },
      body,
    };
  },
};
