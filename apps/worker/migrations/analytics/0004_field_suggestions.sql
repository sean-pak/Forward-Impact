-- Phase 14: headers of uploaded tables that no mapping used and no active field names, counted by header only
-- (never a cell value). At two sightings the header becomes a `pending` row in `fields` for staff to approve or dismiss.
CREATE TABLE field_suggestions (
  field_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);
