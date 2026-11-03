/**
 * The standard `Symbol.asyncDispose`, falling back to `Symbol.for("Symbol.asyncDispose")`
 * on runtimes that lack it. Works with `await using`.
 */
export const asyncDispose: typeof Symbol.asyncDispose =
  Symbol.asyncDispose ?? (Symbol.for("Symbol.asyncDispose") as typeof Symbol.asyncDispose);

/**
 * The standard `Symbol.dispose`, falling back to `Symbol.for("Symbol.dispose")`
 * on runtimes that lack it. Works with `using`.
 */
export const dispose: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for("Symbol.dispose") as typeof Symbol.dispose);

/**
 * Lifecycle hook awaited by the container after an instance is created and before it is
 * handed to dependents. Use it for async initialization a constructor cannot do.
 * If it throws, the instance is disposed and the error propagates.
 */
export const init: unique symbol = Symbol.for("@cyrenex/di.init");

export interface Initializable {
  [init](): void | PromiseLike<void>;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

export function isDisposable(value: unknown): value is AsyncDisposable | Disposable {
  return isObject(value) && (asyncDispose in value || dispose in value);
}

export async function disposeValue(value: unknown): Promise<void> {
  if (!isDisposable(value)) return;
  if (asyncDispose in value) await value[asyncDispose]();
  else value[dispose]();
}

export async function initValue(value: unknown): Promise<void> {
  if (!isObject(value) || typeof (value as Partial<Initializable>)[init] !== "function") return;
  try {
    await (value as Initializable)[init]();
  } catch (error) {
    try {
      await disposeValue(value);
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], "Initialization and cleanup both failed");
    }
    throw error;
  }
}
