export type PondErrorCode =
  | "DUPLICATE_PROVIDER"
  | "PROVIDER_LOCKED"
  | "MISSING_PROVIDER"
  | "CIRCULAR_DEPENDENCY"
  | "CAPTIVE_DEPENDENCY"
  | "DISPOSED";

export class PondError extends Error {
  override name = "PondError";
  readonly code: PondErrorCode;
  /** Dependency path leading to the error, outermost first. */
  readonly path: readonly string[];

  constructor(code: PondErrorCode, message: string, path: readonly string[] = []) {
    super(path.length > 0 ? `${message} (${path.join(" -> ")})` : message);
    this.code = code;
    this.path = path;
  }
}
