-- Razorpay subscriptions. users.plan stays the single source of truth for entitlements and is
-- only changed by the verified Razorpay webhook (see src/lib/billing.ts).
CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  razorpay_subscription_id text NOT NULL UNIQUE,
  plan                     text NOT NULL,
  status                   text NOT NULL DEFAULT 'created',
  current_end              timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, created_at DESC);

-- Razorpay may deliver a webhook more than once; the event id makes handling idempotent.
CREATE TABLE billing_events (
  event_id    text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
