-- A Frigate asking to be linked to an account. The device code is held only
-- by that Frigate; the user code is what the account owner confirms.
CREATE TABLE link_requests (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  instance_name TEXT NOT NULL,
  origin_scheme TEXT NOT NULL,
  origin_host TEXT NOT NULL,
  origin_port INTEGER NOT NULL,
  -- pending, approved, denied or completed
  status TEXT NOT NULL,
  user_id TEXT,
  account_label TEXT,
  -- Set when provisioning starts so a retried poll resumes the same instance.
  instance_id TEXT,
  -- Provisioning lease, so two concurrent polls do not both provision.
  claimed_until INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX link_requests_expires_at ON link_requests (expires_at);

-- A linked Frigate. Its id is also the first label of its hostname.
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_label TEXT,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  -- SHA-256 of the instance secret; the secret itself is never stored.
  secret_hash TEXT,
  origin_scheme TEXT NOT NULL,
  origin_host TEXT NOT NULL,
  origin_port INTEGER NOT NULL,
  -- Checkpoints, written as soon as each Cloudflare resource exists, so a
  -- retry adopts what an interrupted attempt created.
  tunnel_id TEXT,
  dns_record_id TEXT,
  -- The origin the tunnel's ingress currently points at.
  configured_origin TEXT,
  -- provisioning, active or deleting
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sync_at INTEGER
);

CREATE INDEX instances_user_id ON instances (user_id);
CREATE INDEX instances_state ON instances (state);
