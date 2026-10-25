-- Phase 10: person-level ingest (attendance sheets and individual rows).
-- "N names and M CDCR numbers scrambled" in the receipt: counts only, never the values.
ALTER TABLE submissions ADD COLUMN scrambled_names INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN scrambled_cdcr INTEGER NOT NULL DEFAULT 0;
-- The mark as written (at most 6 characters; longer free text is stored as "?"). Lets a legend answer re-read the marks.
ALTER TABLE session_attendance ADD COLUMN raw_mark TEXT;
-- The CBO's own "completed" mark, kept beside the derived `completed` so a rule disagreement can be counted.
ALTER TABLE enrollments ADD COLUMN cbo_completed TEXT NOT NULL DEFAULT 'unknown' CHECK (cbo_completed IN ('yes','no','in_progress','unknown'));

-- Person-level facts that are not tied to one cycle (attributes, release, custody). Held here until the CBO
-- confirms the submission, then promoted. No identifiers: person_key and coarse attributes only.
-- payload: {"birth_year","age_band","risk_band","release":{"date","fiscal_year","supervision","post_program"},"projected_release","custody"}
CREATE TABLE staged_people (
  submission_id TEXT NOT NULL,
  person_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (submission_id, person_key)
);
