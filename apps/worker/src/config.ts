/** A missing or malformed setting or secret. Retrying cannot fix it, so callers hand the work to staff at once. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
