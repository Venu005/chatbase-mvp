# Billing with Razorpay

Customers subscribe to monthly INR plans with Razorpay Checkout (cards, UPI Autopay and other methods your Razorpay account
has enabled). Billing is optional: with the Razorpay variables blank the app runs normally and the Upgrade buttons are disabled.

## Plans

Defined in `src/lib/plans.ts`. The prices and limits are placeholders, tune them to your costs (AI usage, Meta charges).

| Plan | Price | Message credits / month | Agents |
| --- | --- | --- | --- |
| Free | ₹0 | 50 | 1 |
| Starter | ₹999 | 1,000 | 3 |
| Growth | ₹2,999 | 5,000 | 10 |
| Pro | ₹7,999 | 20,000 | 30 |

Every assistant answer uses one credit, on the website and on WhatsApp. Handing a chat to a person costs nothing. GST and
invoicing are **not** handled (see "Not built" below).

## Setup

1. **Razorpay account.** Create one and stay in **Test mode** at first. Dashboard, Account & Settings, API Keys, generate a
   key pair:
   ```
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```
   Subscriptions/recurring payments must be enabled on your Razorpay account (Razorpay may need to activate it).
2. **Create the plans.** This creates one monthly INR plan per paid tier from `src/lib/plans.ts` and is safe to re-run:
   ```bash
   pnpm razorpay:setup
   ```
   It prints three lines; paste them into `.env`:
   ```
   RAZORPAY_PLAN_STARTER=plan_...
   RAZORPAY_PLAN_GROWTH=plan_...
   RAZORPAY_PLAN_PRO=plan_...
   ```
   If you change a price in `plans.ts`, create a new plan (Razorpay plans cannot be edited) and update the id.
3. **Create the webhook.** Dashboard, Account & Settings, Webhooks, add:
   - URL: `APP_URL/api/razorpay/webhook` (public https)
   - Secret: a random string you choose, also put in `.env` as `RAZORPAY_WEBHOOK_SECRET`
   - Events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`,
     `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`,
     `subscription.resumed`, `subscription.updated`
4. Restart the app and run `pnpm preflight --live` (verifies the keys and that each plan id exists in your account).
5. Sign in, open **Plans & billing**, choose a plan and pay with Razorpay's test payment methods (see Razorpay's "test
   payments" documentation).

## How it works and why it is safe

- The plan on a user's account changes **only** when the verified Razorpay webhook says so. The browser's checkout result
  is signature-checked but never upgrades anyone, so a user cannot upgrade by faking a redirect.
- Webhooks are verified with `RAZORPAY_WEBHOOK_SECRET` against the raw body, are idempotent (Razorpay's event id is
  remembered), and a subscription whose Razorpay plan id does not match the plan we sold is ignored.
- Lifecycle: `activated`, `charged` and `resumed` start or keep the paid plan (`authenticated` only records that the customer
  authorised the payment, it does not grant the plan); `pending` (a failed renewal that Razorpay is retrying) keeps the plan
  for now; `halted` (retries exhausted), `cancelled`, `completed` and `paused` return the account to Free. Late
  "activated/charged" events that arrive after a subscription ended cannot bring it back.
- **Cancel** stops renewal at the end of the paid period; the plan stays until then. If the customer has not paid yet, the
  subscription is cancelled at once. Razorpay documents that a cycle-end cancellation only changes the status to `cancelled`
  at the end of the cycle; it does not spell out when the `subscription.cancelled` webhook is sent, so **confirm in test mode**
  that your customer keeps the plan until the period ends.
- **Changing plans** means cancelling and subscribing again (in-place upgrades with proration are not built).

## Going live

1. Complete Razorpay's account activation for your business.
2. Generate **live** keys (`rzp_live_...`), run `pnpm razorpay:setup` again (plans are per mode), create the webhook in Live
   mode with its own secret, and update all `RAZORPAY_*` values.
3. Run `pnpm preflight --live` (it warns that live keys move real money), then make one real purchase and refund it.

## Not built

- GST invoices and tax handling, credit notes, refunds from the dashboard.
- Proration and in-place plan changes.
- Usage-based top-ups when credits run out (the assistant tells visitors the business has reached its limit).
- Emails to customers about billing (Razorpay sends its own payment notifications: `customer_notify` is on).

The Razorpay code was tested against a fake Razorpay API and a scripted browser with a fake Checkout, **not** against live or
test-mode Razorpay. Do a full test-mode run before launch.
