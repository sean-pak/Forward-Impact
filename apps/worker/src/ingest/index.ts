import * as mammoth from "mammoth/mammoth.browser.js";
import {
  ColumnMappingSchema, ExtractionResultSchema, extractionToRows, findHeaderRow, isIndividualLevel, profileColumns,
  rowsFromMapping, scrubIdentifiers, type CycleIssue,
} from "@tpw/shared";
import { writeSubmission, type OrgRow } from "../form";
import type { Llm } from "../llm";
import { TABLE_SYSTEM, TEXT_SYSTEM } from "./prompts";
import { readGrid } from "./table";

export type IngestInput =
  | { kind: "text"; text: string }
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "table"; filename: string; bytes: Uint8Array };

export type IngestMeta = { channel: "email_body" | "email_attachment" | "manual"; senderEmail: string };

export type IngestOutcome = {
  submission_id: string | null;
  status: "needs_info" | "awaiting_confirmation" | "needs_staff" | "no_data";
  cycles: number;
  note?: string;
};

export const PARSER_VERSION = "ingest-1";
const MAX_TABLE_ROWS = 200;

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
    senderEmail: meta.senderEmail, preIssues, duplicates: "flag",
  });
  if (!w.ok) throw new Error(w.error);
  await noteDetectedPersona(db, org, result.persona);
  return { submission_id: w.submission_id, status: w.blocked ? "needs_info" : "awaiting_confirmation", cycles: rows.length };
}

/** Persona 1: the LLM sees only a masked column profile; code reads every value. */
async function ingestTable(db: D1Database, llm: Llm, org: OrgRow, filename: string, bytes: Uint8Array, meta: IngestMeta): Promise<IngestOutcome> {
  const grid = readGrid(filename, bytes);
  if (grid.length < 2) return { submission_id: null, status: "no_data", cycles: 0, note: "The file has no rows." };
  const headerRow = findHeaderRow(grid);
  const profile = profileColumns(grid, headerRow);
  const mapping = await llm.json({
    name: "map_columns", system: TABLE_SYSTEM, schema: ColumnMappingSchema,
    user: JSON.stringify({ row_count: grid.length - headerRow - 1, columns: profile }),
  });
  if (mapping.columns.some((c) => c.index >= profile.length)) throw new Error("column mapping points past the last column");

  if (isIndividualLevel(mapping) || grid.length - headerRow - 1 > MAX_TABLE_ROWS) {
    const id = await recordNeedsStaff(db, org, meta, mapping.persona, true);
    return {
      submission_id: id, status: "needs_staff", cycles: 0,
      note: isIndividualLevel(mapping) ? "This looks like a person-level file. It is not read yet; staff will follow up." : "The file has too many rows for the aggregate path.",
    };
  }
  const { rows } = rowsFromMapping(grid, headerRow, mapping);
  if (rows.length === 0) return { submission_id: null, status: "no_data", cycles: 0, note: "The file has no data rows." };
  const w = await writeSubmission(db, org, rows, {
    channel: meta.channel, parserVersion: PARSER_VERSION, llmMappingUsed: true, detectedPersona: mapping.persona,
    senderEmail: meta.senderEmail, duplicates: "flag",
  });
  if (!w.ok) throw new Error(w.error);
  await noteDetectedPersona(db, org, mapping.persona);
  return { submission_id: w.submission_id, status: w.blocked ? "needs_info" : "awaiting_confirmation", cycles: rows.length };
}

/** One pipeline for email and for admin upload, so both give the same result. */
export async function ingest(db: D1Database, llm: Llm, org: OrgRow, input: IngestInput, meta: IngestMeta): Promise<IngestOutcome> {
  if (input.kind === "table") return ingestTable(db, llm, org, input.filename, input.bytes, meta);
  const text = input.kind === "docx" ? await docxToText(input.bytes) : input.text;
  return ingestText(db, llm, org, text, meta);
}

export type { OrgRow };
export { readGrid };
