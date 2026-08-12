import type { Provider } from './types.js';
import { shopify } from './shopify.js';
import { stripe } from './stripe.js';

const REGISTRY = new Map<string, Provider>([
  [shopify.name, shopify],
  [stripe.name, stripe],
]);

export function getProvider(name: string): Provider {
  const provider = REGISTRY.get(name);
  if (!provider) {
    throw new Error(`unknown provider "${name}", available: ${[...REGISTRY.keys()].join(', ')}`);
  }
  return provider;
}

export function providerNames(): string[] {
  return [...REGISTRY.keys()];
}

export { shopify, shopifyHmac } from './shopify.js';
export { stripe, stripeSignature, stripeEventId, STRIPE_TOLERANCE_SECONDS } from './stripe.js';
export type { Provider, SignInput, OutgoingRequest, PreparePayloadInput } from './types.js';
