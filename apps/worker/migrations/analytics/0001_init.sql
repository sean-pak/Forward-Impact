-- tpw_analytics: no direct identifiers anywhere in this database (PRD 6).
-- Field names and enums follow docs/schema-v2.md; placements follow PRD 8.
-- No FOREIGN KEY clauses: references are logical, so db:reset can drop in any order.
-- Booleans are INTEGER 0/1, dates are 'YYYY-MM-DD' TEXT, timestamps are ISO 8601 TEXT,
-- list/object columns are JSON TEXT.
-- cycle_metrics and cohort_outcome_metrics (schema 8.1, 8.2) are computed by pure
-- functions in packages/shared and are not stored.

CREATE TABLE orgs (
  org_id TEXT PRIMARY KEY,
  org_name TEXT NOT NULL,
  org_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (org_type IN ('arts','education','reentry','healing','faith','legal','employment','other','unknown')),
  data_persona INTEGER NOT NULL CHECK (data_persona BETWEEN 1 AND 4),
  primary_contact_email TEXT NOT NULL,
  has_data_agreement INTEGER NOT NULL DEFAULT 0,
  private_token TEXT UNIQUE,
  form_token TEXT UNIQUE,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE contacts (
  contact_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  title TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (org_id, email)
);
CREATE INDEX idx_contacts_email ON contacts (email);

CREATE TABLE facilities (
  facility_code TEXT PRIMARY KEY,
  facility_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE programs (
  program_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  program_name TEXT NOT NULL,
  program_category TEXT NOT NULL DEFAULT 'unknown'
    CHECK (program_category IN ('education','cognitive_behavioral','substance_use','arts','job_training','faith','restorative_justice','other','unknown')),
  completion_rule TEXT NOT NULL DEFAULT 'unstated',
  credit_types_offered TEXT NOT NULL DEFAULT '[]',
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_programs_org ON programs (org_id);

CREATE TABLE program_cycles (
  cycle_id TEXT PRIMARY KEY,
  cycle_key TEXT NOT NULL,            -- dedupe key: org|program|facility|start_date, 'unknown' for gaps
  program_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  facility_code TEXT,
  yard TEXT,
  start_date TEXT,
  end_date TEXT,
  sessions_planned INTEGER,
  course_hours_planned_per_participant REAL,
  n_enrolled INTEGER,
  n_completed INTEGER,
  total_course_hours_delivered REAL,
  n_enrolled_approx INTEGER NOT NULL DEFAULT 0,
  n_completed_approx INTEGER NOT NULL DEFAULT 0,
  total_course_hours_delivered_approx INTEGER NOT NULL DEFAULT 0,
  source_grain TEXT NOT NULL CHECK (source_grain IN ('aggregate','derived_from_individuals')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','awaiting_confirmation','confirmed','superseded')),
  extra TEXT NOT NULL DEFAULT '{}',   -- answers for registry fields (table fields)
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_cycles_org ON program_cycles (org_id, status);
CREATE INDEX idx_cycles_key ON program_cycles (cycle_key);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT CHECK (cancel_reason IN ('lockdown','staff_unavailable','facility_event','holiday','other','unknown')),
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_sessions_cycle ON sessions (cycle_id);

CREATE TABLE session_attendance (
  session_id TEXT NOT NULL,
  person_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','excused','late','unknown')),
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (session_id, person_key)
);

CREATE TABLE enrollments (
  enrollment_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  person_key TEXT NOT NULL,
  enrollment_date TEXT,
  sessions_attended INTEGER,
  sessions_planned_for_person INTEGER,
  attendance_rate REAL,
  hours_attended REAL,
  completed TEXT NOT NULL DEFAULT 'unknown' CHECK (completed IN ('yes','no','in_progress','unknown')),
  completion_basis TEXT NOT NULL DEFAULT 'unknown' CHECK (completion_basis IN ('rule_applied','cbo_marked','unknown')),
  completion_date TEXT,
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (cycle_id, person_key)
);
CREATE INDEX idx_enrollments_person ON enrollments (person_key);

CREATE TABLE person_attributes (
  person_key TEXT PRIMARY KEY,
  birth_year INTEGER,
  age_band_at_release TEXT NOT NULL DEFAULT 'unknown'
    CHECK (age_band_at_release IN ('18_19','20_24','25_29','30_34','35_39','40_44','45_49','50_54','55_59','60_plus','unknown')),
  age_band_raw TEXT,
  risk_band TEXT NOT NULL DEFAULT 'unknown' CHECK (risk_band IN ('low','moderate','high','unknown')),
  commitment_offense_category TEXT NOT NULL DEFAULT 'unknown' CHECK (commitment_offense_category IN ('persons','property','drug','other','unknown')),
  sentence_type TEXT NOT NULL DEFAULT 'unknown' CHECK (sentence_type IN ('determinate','determinate_2nd_strike','indeterminate','third_strike','unknown')),
  prior_cdcr_stays_band TEXT NOT NULL DEFAULT 'unknown' CHECK (prior_cdcr_stays_band IN ('1','2','3','4','5_9','10_plus','unknown')),
  county_of_release TEXT,
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE credit_awards (
  credit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_key TEXT NOT NULL,
  cycle_id TEXT,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('rac','emc','mcc','other','unknown')),
  credit_days_earned INTEGER NOT NULL,
  credit_days_applied INTEGER,        -- null when unknown; never copy earned into applied
  award_date TEXT,
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_credits_person ON credit_awards (person_key);

CREATE TABLE consents (
  person_key TEXT NOT NULL,
  org_id TEXT NOT NULL,
  consent_followup INTEGER NOT NULL,
  consent_share_with_tpw INTEGER NOT NULL,
  consent_date TEXT NOT NULL,
  revoked_date TEXT,
  consent_form_version TEXT NOT NULL,
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (person_key, org_id)
);

CREATE TABLE custody_status (
  person_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('in_custody','released','unknown')),
  projected_release_date TEXT,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('cbo_report','locator','cdcr_file','simulated')),
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE release_events (
  release_id TEXT PRIMARY KEY,
  person_key TEXT NOT NULL,
  release_date TEXT NOT NULL,
  release_fiscal_year TEXT,           -- derived, 'FY2022_23'
  release_type TEXT NOT NULL DEFAULT 'unknown' CHECK (release_type IN ('first_release','re_release','discharge','unknown')),
  supervision_type TEXT NOT NULL DEFAULT 'unknown' CHECK (supervision_type IN ('parole','prcs','discharged','unknown')),
  source TEXT NOT NULL CHECK (source IN ('cbo_report','locator','cdcr_file','simulated')),
  post_program INTEGER,               -- derived
  submission_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_releases_person ON release_events (person_key);

CREATE TABLE custody_checks (
  check_id TEXT PRIMARY KEY,
  person_key TEXT NOT NULL,           -- query inputs and raw response live in the vault (locator_raw)
  checked_at TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK (source_system IN ('eit_locator','mock_locator','cdcr_file')),
  query_method TEXT NOT NULL CHECK (query_method IN ('cdcr_number','name','name_plus_cdcr')),
  method_of_access TEXT NOT NULL CHECK (method_of_access IN ('http_script','browser_automation','computer_use','manual')),
  result TEXT NOT NULL CHECK (result IN ('found_in_custody','not_found','multiple_matches','error','blocked')),
  returned_facility TEXT,
  returned_admission_date TEXT,
  returned_release_date TEXT,
  match_confidence TEXT NOT NULL CHECK (match_confidence IN ('exact_cdcr','name_and_dob','name_only','none')),
  verified_by_human INTEGER NOT NULL DEFAULT 0,
  raw_response_ref TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_checks_person ON custody_checks (person_key);

CREATE TABLE outcome_events (
  person_key TEXT NOT NULL,
  release_id TEXT NOT NULL,
  outcome_type TEXT NOT NULL CHECK (outcome_type IN ('return_to_prison','conviction','arrest','county_jail')),
  outcome_date TEXT NOT NULL,
  outcome_date_precision TEXT NOT NULL CHECK (outcome_date_precision IN ('exact','interval')),
  outcome_date_earliest TEXT,
  days_to_outcome INTEGER,            -- derived
  within_3yr INTEGER,                 -- derived
  outcome_offense_category TEXT CHECK (outcome_offense_category IN ('persons','property','drug_alcohol','other','supervision_violation','unknown')),
  outcome_source TEXT NOT NULL CHECK (outcome_source IN ('simulated','mock_locator','eit_locator_verified','eit_locator_unverified','cdcr_file','doj_file','self_report')),
  evidence_check_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (person_key, release_id, outcome_type)
);

CREATE TABLE follow_up_status (
  person_key TEXT NOT NULL,
  release_id TEXT NOT NULL,
  days_observed INTEGER NOT NULL,
  last_negative_check TEXT,
  censored INTEGER NOT NULL,
  follow_up_complete INTEGER NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (person_key, release_id)
);

CREATE TABLE submissions (
  submission_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('form','email_body','email_attachment','manual')),
  received_at TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  raw_file_ref TEXT,
  detected_persona INTEGER CHECK (detected_persona BETWEEN 1 AND 4),
  parser_version TEXT NOT NULL,
  llm_mapping_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','needs_info','awaiting_confirmation','confirmed','rejected','superseded','needs_staff')),
  followup_rounds INTEGER NOT NULL DEFAULT 0 CHECK (followup_rounds BETWEEN 0 AND 2),
  supersedes_submission_id TEXT,
  confirmed_by_cbo_at TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_submissions_org ON submissions (org_id, status);

CREATE TABLE field_issues (
  issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  field_name TEXT NOT NULL,
  row_ref TEXT,                       -- cycle_id or similar; never an identifier
  issue_type TEXT NOT NULL CHECK (issue_type IN ('missing_required','invalid_value','out_of_range','conflict','ambiguous_mapping')),
  raw_value TEXT,
  message TEXT NOT NULL,              -- plain-language, schema 12
  question_asked TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_issues_submission ON field_issues (submission_id, resolved);

CREATE TABLE fields (
  field_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','integer','number','boolean','date','enum')),
  options TEXT,                       -- JSON array, enum fields only
  required INTEGER NOT NULL DEFAULT 0,
  ask_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','pending')),
  is_core INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Metadata only. Email bodies are never stored here: they can contain names.
-- Subject is stored for outbound mail only.
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,        -- Gmail message id
  gmail_thread_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  kind TEXT NOT NULL DEFAULT 'inbound'
    CHECK (kind IN ('inbound','ask','clarify','confirm_receipt','thanks','escalated','test')),
  org_id TEXT,
  submission_id TEXT,
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  occurred_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_messages_thread ON messages (gmail_thread_id);

CREATE TABLE outreach (
  outreach_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  message_id TEXT,
  sent_at TEXT NOT NULL,
  opened_at TEXT,                     -- approximate: image-pixel based
  open_count INTEGER NOT NULL DEFAULT 0,
  replied_at TEXT,
  touch_number INTEGER NOT NULL DEFAULT 1,
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_outreach_org ON outreach (org_id);

CREATE TABLE assumptions (
  assumption_id TEXT PRIMARY KEY,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','todo_confirm')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE benchmark_reference (
  benchmark_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  cohort_fy TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  stratum_field TEXT NOT NULL,
  stratum_value TEXT NOT NULL,
  numerator INTEGER,
  denominator INTEGER,
  rate REAL NOT NULL,
  period_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
