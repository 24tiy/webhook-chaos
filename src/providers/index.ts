import type { Provider } from './types.js';
import { shopify } from './shopify.js';

const REGISTRY = new Map<string, Provider>([[shopify.name, shopify]]);

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
export type { Provider, SignInput, OutgoingRequest } from './types.js';
