-- Phase 9: the one question Sam is waiting on for an emailed submission (JSON, null when none).
-- Shape: {"kind":"clarify"|"approx"|"confirm","field_name":string,"cycle_ids":string[],"text":string}
ALTER TABLE submissions ADD COLUMN open_question TEXT;
