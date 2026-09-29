-- WhatsApp Embedded Signup: customers connect their own number through Meta's popup, so we never ask them
-- to paste tokens. Those channels use the platform's Meta app (META_APP_SECRET) instead of a per-channel app secret.
ALTER TABLE whatsapp_channels
  ADD COLUMN source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','embedded')),
  ADD COLUMN waba_id             text,
  ADD COLUMN business_id         text,
  ADD COLUMN registration_pin_enc text,
  ALTER COLUMN app_secret_enc DROP NOT NULL;
