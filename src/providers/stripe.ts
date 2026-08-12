import { createHmac } from 'node:crypto';
import { findEpochAnchor, shiftEpochFields } from '../timeshift.js';
import type { OutgoingRequest, PreparePayloadInput, Provider, SignInput } from './types.js';

const ANCHOR_FIELDS = ['created'] as const;

const EPOCH_FIELDS = [
  'created',
  'date',
  'available_on',
  'arrival_date',
  'effective_at',
  'start_date',
  'ended_at',
  'canceled_at',
  'cancel_at',
  'trial_start',
  'trial_end',
  'period_start',
  'period_end',
  'current_period_start',
  'current_period_end',
  'next_payment_attempt',
  'webhooks_delivered_at',
  'finalized_at',
  'paid_at',
  'voided_at',
  'marked_uncollectible_at',
  'due_date',
  'expires_at',
  'submitted_at',
] as const;

export const STRIPE_TOLERANCE_SECONDS = 300;

export function stripeEventId(webhookId: string): string {
  return `evt_${webhookId.replace(/-/g, '').slice(0, 24)}`;
}

export function stripeSignature(body: Buffer, secret: string, signedAt: Date): string {
  const timestamp = Math.floor(signedAt.getTime() / 1000);
  const signed = createHmac('sha256', secret).update(`${timestamp}.${body.toString('utf8')}`).digest('hex');
  return `t=${timestamp},v1=${signed}`;
}

export const stripe: Provider = {
  name: 'stripe',

  sensitiveKeys: [
    'billing_details',
    'shipping',
    'receipt_email',
    'customer_email',
    'email',
    'name',
    'phone',
    'address',
    'owner',
    'metadata',
    'description',
    'statement_descriptor',
    'receipt_url',
    'hosted_invoice_url',
    'invoice_pdf',
    'client_secret',
  ],

  retryOffsetsMs: [
    0,
    300_000,
    1_800_000,
    7_200_000,
    18_000_000,
    36_000_000,
    86_400_000,
    172_800_000,
    259_200_000,
  ],

  signatureHeader: 'stripe-signature',

  carriedHeaders: [],

  anchorOf(payload) {
    return findEpochAnchor(payload, ANCHOR_FIELDS);
  },

  topicOf(_headers, payload) {
    if (payload === null || typeof payload !== 'object') return null;
    const type = (payload as Record<string, unknown>)['type'];
    return typeof type === 'string' ? type : null;
  },

  preparePayload({ payload, anchor, eventTime, webhookId }: PreparePayloadInput): unknown {
    const shifted =
      anchor === null ? payload : shiftEpochFields(payload, eventTime.getTime() - Date.parse(anchor), EPOCH_FIELDS);

    if (shifted === null || typeof shifted !== 'object') return shifted;
    return { ...(shifted as Record<string, unknown>), id: stripeEventId(webhookId) };
  },

  build({ body, secret, signedAt }: SignInput): OutgoingRequest {
    return {
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
        'stripe-signature': stripeSignature(body, secret, signedAt),
      },
      body,
    };
  },
};
