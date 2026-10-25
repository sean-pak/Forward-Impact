import {
  MockLocatorFileSchema, eitRefusal, searchMock,
  type LocatorQuery, type LocatorResult, type LocatorSource, type LocatorSubject, type MockLocatorFile,
} from "@tpw/shared";
import mockFile from "./mock_locator.json";

/** A guard said no. The lookup is recorded as `blocked`, not `error`. */
export class LocatorRefused extends Error {}

/** PRD 9: `lookup({ cdcr?, first?, last? }) -> LocatorResult`. The subject lets the real adapter check its guards. */
export interface Locator {
  source: LocatorSource;
  lookup(query: LocatorQuery, subject: LocatorSubject): Promise<LocatorResult>;
}

let parsed: MockLocatorFile | undefined;
/** Muse's mock_locator.json, validated once. A bad file fails loudly here, not halfway through a cohort. */
export const mockData = (): MockLocatorFile => (parsed ??= MockLocatorFileSchema.parse(mockFile));

/** Answers from the bundled file. Synthetic people only: a real person's name in the mock would give a made-up answer. */
export function mockLocator(file: MockLocatorFile = mockData()): Locator {
  return {
    source: "mock_locator",
    async lookup(query, subject) {
      if (!subject.isSynthetic) throw new LocatorRefused("The mock locator only answers for synthetic people.");
      return searchMock(file, query);
    },
  };
}

/**
 * The real EIT locator holds real CDCR data. Every guard from PRD 9 runs before anything else, and the client itself is
 * not built: even with every guard passing this throws, so no code path can reach the real URL during the hackathon.
 */
export function eitLocator(opts: { enabled: boolean; recentMs: () => number[]; now?: () => number }): Locator {
  return {
    source: "eit_locator",
    async lookup(query, subject) {
      const refusal = eitRefusal({ enabled: opts.enabled, subject, query, recentMs: opts.recentMs(), nowMs: (opts.now ?? Date.now)() });
      if (refusal) throw new LocatorRefused(refusal);
      throw new Error("The real locator client is not built yet (needs TPW authorization first; see docs/PRD.md section 9).");
    },
  };
}
