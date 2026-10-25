import type { IndividualExtra } from "@tpw/shared";

/** What a person-level cycle adds to writeSubmission: state for program_cycles.extra and the rows that belong to the cycle. */
export type IndividualRow = {
  extra: IndividualExtra;
  children: (ctx: { cycleId: string; submissionId: string }) => D1PreparedStatement[];
};
