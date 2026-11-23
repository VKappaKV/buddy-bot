CREATE TABLE IF NOT EXISTS diary (
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  message_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  text TEXT NOT NULL,
  audio_key TEXT,
  audio_bytes INTEGER,
  receipt TEXT NOT NULL DEFAULT 'pending' CHECK (receipt IN ('pending', 'sending', 'sent', 'unknown')),
  PRIMARY KEY (channel, message_id)
);

CREATE TABLE IF NOT EXISTS test_owners (
  channel TEXT PRIMARY KEY CHECK (channel IN ('telegram', 'whatsapp')),
  user_id TEXT NOT NULL
);
