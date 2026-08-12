# webhook-chaos

Deterministic webhook delivery testing. Replay recorded Shopify events late, duplicated and out of order, with valid signatures.

Shopify does not guarantee the order in which webhooks arrive, and the same webhook can be delivered more than once. Failed deliveries are retried up to 8 times over 4 hours. Most apps are only ever tested against the happy path: one event, delivered once, in the order it was created.

The fixtures in this repository were recorded from a real development store, and `orders/create` arrived fourth, after the payment. No retries, no failures, one healthy endpoint.

`webhook-chaos` delivers your fixtures the way production does.

```
stale-update · shopify → http://localhost:3000/webhooks
  4 deliveries · time scale 3600x

  +0s       orders/create             200     #4e8b4bbf
  +3ms      orders/paid               200     #005f22c2
  +6ms      orders/cancelled          200     #d36f182e
  +4s       orders/updated            200     #ed16eb37 stale by 3h59m55s

  4 delivered · 0 duplicates · 0 retries · 4 accepted · 0 non-2xx · 0 unreachable
  assertions are yours: check your own state now
```

## Not Toxiproxy

[Toxiproxy](https://github.com/Shopify/toxiproxy), built by Shopify, breaks the network: latency, timeouts, bandwidth, dropped connections. It works at the TCP level, where `X-Shopify-Topic: orders/paid` and `X-Shopify-Topic: orders/cancelled` are the same stream of bytes.

Webhooks fail differently. They arrive late, twice, and in the wrong order, over a network that was working perfectly the whole time. `webhook-chaos` breaks the semantics of event delivery, not the wire underneath it.

## Install

```bash
npm install --save-dev webhook-chaos
```

## The demo

The repository ships a deliberately naive Shopify app: it verifies the HMAC and then applies every order webhook in arrival order.

```bash
node examples/naive-app.mjs
```

In another shell, replay an order that gets cancelled while an earlier update is still in flight, compressing four hours into four seconds:

```bash
npx webhook-chaos replay scenarios/stale-update.yml \
  --target http://localhost:3000/webhooks \
  --secret test-signing-secret \
  --time-scale 1h=1s
```

The app receives create, paid, cancelled, and finally the update that was generated before the cancellation:

```
  orders/create     applied
  orders/paid       applied
  orders/cancelled  applied
  orders/updated    applied
```

```bash
curl -s localhost:3000/state
```

```json
{
  "5678901234567": {
    "financialStatus": "paid",
    "cancelledAt": null,
    "lastTopic": "orders/updated"
  }
}
```

The order was cancelled and refunded. The app thinks it is paid and ready to ship.

Run the same scenario against `node examples/naive-app.mjs --guarded`, which compares `updated_at` against stored state before applying, and the cancellation survives.

## Recording your own fixtures

Point a Shopify webhook at the recorder instead of your app:

```bash
npx webhook-chaos record --out fixtures/shopify --forward http://localhost:3000/webhooks
```

The recorder answers Shopify immediately with `200`, then stores the request and passes the original bytes to your app untouched, so your existing signature check still passes. Storing the fixture never blocks the acknowledgement, which is what keeps Shopify from retrying deliveries you did not ask for.

Customer data is scrubbed before anything is written to disk. Emails, phone numbers, addresses, notes, IPs, checkout tokens and `order_status_url` are replaced with placeholders of the same shape; ids, prices, SKUs and timestamps are kept. Fixtures end up in your repository, so this is on by default. `--no-redact` turns it off.

## Three clocks

This is the part that makes the difference between a test that proves something and a test that is green by construction.

Every delivery carries three independent times:

| Clock | What it is | `--time-scale` |
|---|---|---|
| wall | when the runner actually sends the request | compressed |
| payload | `created_at`, `updated_at`, `X-Shopify-Triggered-At` | never compressed |
| signature | the moment the request is signed | always now |

A held event is only interesting if the payload still says it happened four hours ago. If you compress the payload clock along with the wall clock, the event arrives claiming to be one second old, every staleness check in the app passes, and the test proves nothing.

So `at` and `deliver_at` are separate:

```yaml
- fixture: order-updated
  at: 5s
  deliver_at: 4h
```

The payload is rewritten to say it happened 5 seconds into the run. The request is sent 4 hours in (or 4 seconds, under `--time-scale 1h=1s`). Timestamps inside the payload are shifted as a block, so `created_at`, `updated_at` and every nested `processed_at` keep their original spacing and their original UTC offsets.

Under `--time-scale` the payload clock stays uncompressed, so payload timestamps can run slightly ahead of the compressed wall clock: an event four scenario-hours out is delivered one real second in, still carrying the timestamp it was generated with. Absolute age against your app's `Date.now()` is what compression costs you. Relative order between payloads, which is what a stale-event test actually depends on, is exact at any scale.

## Scenarios

```yaml
name: order-lifecycle
provider: shopify

events:
  - fixture: order-created
    at: 0s

  - fixture: order-paid
    at: 10s
    duplicate:
      count: 3
      ids: same
      spacing: 0s

  - fixture: order-updated
    at: 15s
    deliver_at: 4h

  - fixture: order-cancelled
    at: 20s
    attempts: 8
```

| Key | Meaning |
|---|---|
| `at` | when the event happened, written into the payload |
| `deliver_at` | when it is delivered; defaults to `at` |
| `duplicate.count` | how many copies to send |
| `duplicate.ids` | `same` reuses the webhook id, `new` mints a fresh one per copy |
| `duplicate.spacing` | gap between copies; `0s` sends them concurrently |
| `attempts` | deliver on the provider's retry schedule, same id and body each time |

`ids: same` tests whether you deduplicate on `X-Shopify-Webhook-Id`. `ids: new` tests whether you are idempotent when that shortcut is not available, which is where the expensive bugs are.

`attempts` and `duplicate` are mutually exclusive: one models the provider retrying, the other models the provider delivering twice.

Deliveries scheduled at the same instant are sent concurrently. Deliveries at different instants are strictly ordered, and the runner waits for the previous batch to be answered before sending the next, so compressing the clock never turns into a race.

Webhook ids are derived from the scenario name and the event index, so two runs of the same scenario send the same ids.

## What it does not do

It has no idea what your app stores, and it makes no assertions. It sends requests and reports what came back. Checking that an order ended up refunded is your test's job.

It cannot make your app fail. Every scenario primitive is something the runner does on its own side: which fixture, when, how many times, with which headers. There is no `drop` and no `fail_attempts`, because a healthy handler will answer `200` no matter what the YAML claims. To test what happens when your handler is down, break your handler; `attempts: 8` will keep delivering into it.

It reports non-2xx responses but does not treat them as failures. The process exits non-zero only when the target could not be reached at all.

## Library

```ts
import { loadScenario, replay } from 'webhook-chaos';

const scenario = await loadScenario('scenarios/stale-update.yml');

const report = await replay({
  scenario,
  fixturesDir: 'fixtures/shopify',
  target: 'http://localhost:3000/webhooks',
  secret: process.env.TEST_WEBHOOK_SECRET,
  timeScale: 14_400,
});

expect(report.summary.accepted).toBe(4);
expect(await orderState('5678901234567')).toMatchObject({ status: 'cancelled' });
```

`startRecorder` is exported too, if you would rather capture fixtures from a test than from the CLI.

## CI

```yaml
- run: node dist/server.js &
- run: npx webhook-chaos replay scenarios/stale-update.yml
       --target http://localhost:3000/webhooks
       --secret ${{ secrets.TEST_WEBHOOK_SECRET }}
       --time-scale 1h=1s
- run: npm run test:webhook-state
```

`--dry-run` prints the delivery plan without sending anything, which is the fastest way to check that a scenario means what you think.

## Providers

Shopify and Stripe. A provider is a signing scheme, a retry schedule, the fields that carry the event's own clock, and the rules for where the topic and the event id live.

The two differ in almost every one of those, which is why the abstraction earns its place:

| | Shopify | Stripe |
|---|---|---|
| signature | base64 HMAC of the body | hex HMAC of `timestamp.body` |
| signature clock | none | `t=` in the header, rejected after 300s |
| topic | `X-Shopify-Topic` header | `type` field in the body |
| event id | `X-Shopify-Webhook-Id` header | `id` field in the body |
| payload clock | ISO 8601 strings | unix integers |
| retries | 8 attempts over 4 hours | 9 attempts over 3 days |

Stripe is why the signature clock is modelled apart from the payload clock. A recorded Stripe fixture cannot be replayed with the signature it arrived with: the official libraries compare `t=` against now and reject anything older than 300 seconds. So every delivery is signed fresh, while the payload keeps the `created` value the scenario gives it. There is a test that asserts exactly this, by checking that re-signing at the fixture's own recorded time would fall outside tolerance.

Shifting a unix clock needs more care than shifting ISO strings, because a payload is full of integers that are not times. Only known keys are shifted (`created`, `period_end`, `trial_end` and friends), and only when the value falls in a plausible epoch range, so `amount: 4495` and `exp_year: 2030` are left alone.

```bash
npx webhook-chaos record --out fixtures/stripe --provider stripe --forward http://localhost:3000/webhooks
```

The Stripe retry schedule is a rougher approximation than the Shopify one. Stripe documents exponential backoff over about three days without publishing the exact intervals, so the shape is right and the individual gaps are invented.

## Fixtures in this repository

The four fixtures under `fixtures/shopify` are real. They were recorded from a Shopify development store on 2026-08-11 at API version 2026-07, from a single order taken through create, paid, updated and cancelled, so they share one order id and one coherent history. Each payload has 94 top-level fields, which is what a real `orders/*` body looks like.

They went through the recorder's scrubber on the way in, and the shop domain was replaced with `webhook-chaos.myshopify.com` afterwards. Every fixture carries a `source` field, and these four say `recorded`.

The Stripe fixtures under `fixtures/stripe` say `synthetic`, because they were written by hand rather than captured from an account. They have the right envelope and the right clock, and they are enough to run the scenario, but record your own before trusting them.

Recording them produced the argument for this tool better than any documentation could. Four events fired in the order create, paid, updated, updated. They arrived in the order **updated, paid, updated, create** — the creation event for the order landed last, after the payment. Nothing was wrong: no retries, no failures, a single healthy endpoint, a 143 ms round trip. That is simply how Shopify delivers.

`scenarios/real-arrival-order.yml` replays that burst, so the thing the store did once can be run against your handler on demand.

There is a fifth fixture, `order-updated-after-cancel`, recorded from the same order after the cancellation. It exists to catch the opposite mistake: an app that guards against stale updates too bluntly and starts dropping legitimate ones. `scenarios/late-update-after-cancel.yml` delivers it four hours late, and a correct handler applies it rather than ignoring it.

The Shopify retry schedule (`0, 5m, 15m, 35m, 1h15m, 2h15m, 3h15m, 4h`) is an approximation of the documented "8 attempts over 4 hours". The count and the total window are right; the exact spacing between attempts is not published.

## License

MIT
