/**
 * Moves a confirmed submission's person-level facts out of staging (attributes, releases, custody).
 * Nothing here runs before the CBO says YES, so unconfirmed rows never reach the tables the dashboard reads.
 * A release the CBO reports again replaces the earlier row (same person and date). The CBO never overwrites
 * custody that a locator check wrote.
 */
export function promoteStatements(db: D1Database, submissionId: string, now: string): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO person_attributes (person_key, birth_year, age_band_at_release, risk_band, submission_id, is_synthetic)
       SELECT person_key, json_extract(payload,'$.birth_year'), COALESCE(json_extract(payload,'$.age_band'),'unknown'),
              COALESCE(json_extract(payload,'$.risk_band'),'unknown'), submission_id, is_synthetic
       FROM staged_people WHERE submission_id = ?
       ON CONFLICT (person_key) DO UPDATE SET
         birth_year = COALESCE(excluded.birth_year, person_attributes.birth_year),
         age_band_at_release = CASE WHEN excluded.age_band_at_release <> 'unknown' THEN excluded.age_band_at_release ELSE person_attributes.age_band_at_release END,
         risk_band = CASE WHEN excluded.risk_band <> 'unknown' THEN excluded.risk_band ELSE person_attributes.risk_band END,
         submission_id = excluded.submission_id`,
    ).bind(submissionId),
    db.prepare(
      `INSERT INTO release_events (release_id, person_key, release_date, release_fiscal_year, release_type, supervision_type, source, post_program, submission_id, is_synthetic)
       SELECT 'rel_' || person_key || '_' || json_extract(payload,'$.release.date'), person_key, json_extract(payload,'$.release.date'),
              json_extract(payload,'$.release.fiscal_year'), 'unknown', COALESCE(json_extract(payload,'$.release.supervision'),'unknown'),
              'cbo_report', json_extract(payload,'$.release.post_program'), submission_id, is_synthetic
       FROM staged_people WHERE submission_id = ? AND json_extract(payload,'$.release.date') IS NOT NULL
       ON CONFLICT (release_id) DO UPDATE SET
         supervision_type = excluded.supervision_type, post_program = excluded.post_program, submission_id = excluded.submission_id`,
    ).bind(submissionId),
    db.prepare(
      `INSERT INTO custody_status (person_key, status, projected_release_date, as_of, source, submission_id, is_synthetic)
       SELECT person_key, json_extract(payload,'$.custody'), json_extract(payload,'$.projected_release'), ?, 'cbo_report', submission_id, is_synthetic
       FROM staged_people WHERE submission_id = ? AND json_extract(payload,'$.custody') IS NOT NULL
       ON CONFLICT (person_key) DO UPDATE SET
         status = excluded.status, projected_release_date = excluded.projected_release_date, as_of = excluded.as_of, submission_id = excluded.submission_id
       WHERE custody_status.source = 'cbo_report'`,
    ).bind(now, submissionId),
    db.prepare("DELETE FROM staged_people WHERE submission_id = ?").bind(submissionId),
  ];
}
