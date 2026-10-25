import * as mammoth from "mammoth/mammoth.browser.js";
import {
  ColumnMappingSchema, ExtractionResultSchema, extractionToRows, findHeaderRow, isIndividualLevel, profileColumns,
  rowsFromMapping, scrubIdentifiers, type CycleIssue,
} from "@tpw/shared";
import { recordHeaderSightings } from "../fields";
import { registryFields, writeSubmission, type OrgRow } from "../form";
import type { Llm } from "../llm";
import { TABLE_SYSTEM, TEXT_SYSTEM } from "./prompts";
import { ingestIndividual, type IdentityStore } from "../individual/ingest";
import { readGrid } from "./table";

export type IngestInput =
  | { kind: "text"; text: string }
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "table"; filename: string; bytes: Uint8Array };

export type IngestMeta = {
  channel: "email_body" | "email_attachment" | "manual";
  senderEmail: string;
  /** Tests only: the date that separates a release from an expected release. Defaults to today (UTC). */
  today?: string;
};
/** Opens the vault when a person-level file arrives. Absent when the vault keys are not configured. */
export type VaultSource = () => Promise<IdentityStore>;

export type IngestOutcome = {
  submission_id: string | null;
  status: "needs_info" | "awaiting_confirmation" | "needs_staff" | "no_data";
  cycles: number;
  note?: string;
};

export const PARSER_VERSION = "ingest-1";
const MAX_TABLE_ROWS = 200;
const MAX_PERSON_ROWS = 2000;

async function recordNeedsStaff(db: D1Database, org: OrgRow, meta: IngestMeta, persona: number | null, llmUsed: boolean): Promise<string> {
  const id = `sub_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO submissions (submission_id, org_id, channel, received_at, sender_email, detected_persona, parser_version, llm_mapping_used, status, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needs_staff', ?)`,
    )
    .bind(id, org.org_id, meta.channel, new Date().toISOString(), meta.senderEmail, persona, PARSER_VERSION, +llmUsed, org.is_synthetic)
    .run();
  return id;
}

/** The imported org starts with a placeholder persona; real orgs take the detected one. */
async function noteDetectedPersona(db: D1Database, org: OrgRow, persona: number | null) {
  if (persona && !org.is_synthetic) await db.prepare("UPDATE orgs SET data_persona = ? WHERE org_id = ?").bind(persona, org.org_id).run();
}

export async function docxToText(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (await mammoth.extractRawText({ arrayBuffer: buf })).value;
}

/** Persona 2 style: prose with numbers. The LLM extracts; code cleans, normalizes and validates. */
async function ingestText(db: D1Database, llm: Llm, org: OrgRow, text: string, meta: IngestMeta): Promise<IngestOutcome> {
  const clean = scrubIdentifiers(text).slice(0, 20_000);
  const result = await llm.json({ name: "extract_cycles", system: TEXT_SYSTEM, user: clean, schema: ExtractionResultSchema });
  if (result.cycles.length === 0) return { submission_id: null, status: "no_data", cycles: 0, note: "No program details found in the text." };
  const { rows, unsupported } = extractionToRows(result, clean);
  const preIssues: CycleIssue[][] = rows.map(() => []);
  for (const u of unsupported) {
    const label = u.field === "n_enrolled" ? "people enrolled" : "people completed";
    preIssues[u.row]!.push({
      field_name: u.field, issue_type: "invalid_value", raw_value: String(u.value),
      message: `We could not find the number of ${label} for ${u.program_name} in what you sent. How many were there?`,
    });
  }
  const w = await writeSubmission(db, org, rows, {
    channel: meta.channel, parserVersion: PARSER_VERSION, llmMappingUsed: false, detectedPersona: result.persona,
    senderEmail: meta.senderEmail, preIssues, duplicates: "flag", askMissingCompleted: true,
  });
  if (!w.ok) throw new Error(w.error);
  await noteDetectedPersona(db, org, result.persona);
  return { submission_id: w.submission_id, status: w.blocked ? "needs_info" : "awaiting_confirmation", cycles: rows.length };
}

/** Persona 1: the LLM sees only a masked column profile; code reads every value. */
async function ingestTable(
  db: D1Database, llm: Llm, org: OrgRow, filename: string, bytes: Uint8Array, meta: IngestMeta, vault?: VaultSource,
): Promise<IngestOutcome> {
  const grid = readGrid(filename, bytes);
  if (grid.length < 2) return { submission_id: null, status: "no_data", cycles: 0, note: "The file has no rows." };
  const headerRow = findHeaderRow(grid);
  const profile = profileColumns(grid, headerRow);
  const mapping = await llm.json({
    name: "map_columns", system: TABLE_SYSTEM, schema: ColumnMappingSchema,
    user: JSON.stringify({ row_count: grid.length - headerRow - 1, columns: profile }),
  });
  if (mapping.columns.some((c) => c.index >= profile.length)) throw new Error("column mapping points past the last column");

  const dataRows = grid.length - headerRow - 1;
  if (isIndividualLevel(mapping)) {
    // Identifiers go to the vault here and nowhere else; without the vault keys the file is not read at all.
    const out = vault && dataRows <= MAX_PERSON_ROWS ? await ingestIndividual(db, org, grid, headerRow, mapping, meta, await vault()) : null;
    if (out) {
      await noteDetectedPersona(db, org, mapping.persona);
      return out;
    }
    const id = await recordNeedsStaff(db, org, meta, mapping.persona, true);
    return {
      submission_id: id, status: "needs_staff", cycles: 0,
      note: !vault ? "This looks like a person-level file, and the vault is not configured, so it was not read." : dataRows > MAX_PERSON_ROWS ? "The file has too many rows." : "I could not read this person-level file; staff will follow up.",
    };
  }
  if (dataRows > MAX_TABLE_ROWS) {
    const id = await recordNeedsStaff(db, org, meta, mapping.persona, true);
    return { submission_id: id, status: "needs_staff", cycles: 0, note: "The file has too many rows for the aggregate path." };
  }
  const registry = await registryFields(db);
  const { rows, unmatchedHeaders } = rowsFromMapping(grid, headerRow, mapping, registry);
  if (rows.length === 0) return { submission_id: null, status: "no_data", cycles: 0, note: "The file has no data rows." };
  const w = await writeSubmission(db, org, rows, {
    channel: meta.channel, parserVersion: PARSER_VERSION, llmMappingUsed: true, detectedPersona: mapping.persona,
    senderEmail: meta.senderEmail, duplicates: "flag", askMissingCompleted: true,
  });
  if (!w.ok) throw new Error(w.error);
  await noteDetectedPersona(db, org, mapping.persona);
  // Recurring unused headers become pending field suggestions. Headers only; a failure here never loses the submission.
  await recordHeaderSightings(db, unmatchedHeaders).catch(() => console.error("field suggestions failed"));
  return { submission_id: w.submission_id, status: w.blocked ? "needs_info" : "awaiting_confirmation", cycles: rows.length };
}

/** One pipeline for email and for admin upload, so both give the same result. */
export async function ingest(db: D1Database, llm: Llm, org: OrgRow, input: IngestInput, meta: IngestMeta, vault?: VaultSource): Promise<IngestOutcome> {
  if (input.kind === "table") return ingestTable(db, llm, org, input.filename, input.bytes, meta, vault);
  const text = input.kind === "docx" ? await docxToText(input.bytes) : input.text;
  return ingestText(db, llm, org, text, meta);
}

export type { OrgRow };
export { readGrid };
