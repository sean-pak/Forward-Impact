-- tpw_vault: ciphertext only. Only code under src/vault/ may query this database.
-- Every encrypted column holds base64(iv|ciphertext), AES-256-GCM, random 12-byte IV per field.

CREATE TABLE person_identity (
  person_key TEXT PRIMARY KEY,
  person_key_basis TEXT NOT NULL CHECK (person_key_basis IN ('cdcr_number','org_internal_id','org_name')),
  cdcr_enc TEXT,
  first_enc TEXT,
  last_enc TEXT,
  dob_enc TEXT,
  org_ids TEXT NOT NULL DEFAULT '{}',  -- JSON { org_id: internal id }; ids are org-scoped, not personal identifiers
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE vault_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  actor TEXT NOT NULL,
  purpose TEXT NOT NULL,
  org_id TEXT,
  n_person_keys INTEGER NOT NULL
);

CREATE TABLE locator_raw (
  check_id TEXT PRIMARY KEY,
  query_enc TEXT NOT NULL,
  response_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
