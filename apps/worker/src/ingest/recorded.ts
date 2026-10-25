import type { Llm, LlmRequest } from "../llm";

/** Replays saved model responses by call name. Used by fixtures and tests; never touches the network. */
export class RecordedLlm implements Llm {
  /** Every user prompt sent, so tests can check what the model would have seen. */
  readonly prompts: string[] = [];
  constructor(private recordings: Record<string, unknown>) {}

  async json<T>(req: LlmRequest<T>): Promise<T> {
    this.prompts.push(req.user);
    if (!(req.name in this.recordings)) throw new Error(`no recorded response for ${req.name}`);
    return req.schema.parse(this.recordings[req.name]);
  }
}
