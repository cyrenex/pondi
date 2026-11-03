export type CyreneErrorCode =
  | "DUPLICATE_PROVIDER"
  | "PROVIDER_LOCKED"
  | "MISSING_PROVIDER"
  | "CIRCULAR_DEPENDENCY"
  | "CAPTIVE_DEPENDENCY"
  | "DISPOSED";

export class CyreneError extends Error {
  override name = "CyreneError";
  readonly code: CyreneErrorCode;
  /** Dependency path leading to the error, outermost first. */
  readonly path: readonly string[];

  constructor(code: CyreneErrorCode, message: string, path: readonly string[] = []) {
    super(path.length > 0 ? `${message} (${path.join(" -> ")})` : message);
    this.code = code;
    this.path = path;
  }
}
