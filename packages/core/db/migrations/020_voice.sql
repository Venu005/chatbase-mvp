-- Voice agents: talking with visitors on the website (microphone) and on phone calls (Plivo / Exotel), through the
-- voice gateway (apps/voice). Voice turns are stored as conversations with channel 'voice' (website) or 'phone'.

ALTER TABLE agents
  ADD COLUMN voice_enabled         boolean NOT NULL DEFAULT false,                -- website microphone button
  ADD COLUMN voice_language        text    NOT NULL DEFAULT 'en-IN',              -- when the caller's language isn't detected
  ADD COLUMN voice_speaker         text    NOT NULL DEFAULT 'anushka',            -- Sarvam Bulbul voice
  ADD COLUMN voice_greeting        text    NOT NULL DEFAULT '',                   -- first thing said ('' = the welcome message)
  ADD COLUMN voice_transfer_number text,                                          -- phone calls: "talk to a person" goes here
  -- Secret in the phone provider's webhook / stream URLs, so strangers can't start (billable) calls on this agent.
  ADD COLUMN voice_token           text    NOT NULL DEFAULT encode(gen_random_bytes(18), 'hex');

-- Time from the end of the caller's sentence to the first audio of the reply.
ALTER TABLE ai_calls ADD COLUMN first_audio_ms integer;
