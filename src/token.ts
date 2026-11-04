declare const TYPE: unique symbol;
const RIPPLE: unique symbol = Symbol("pondi.ripple");

/**
 * Type registry for string keys. Augment it to get types for plain string tokens:
 *
 * ```ts
 * declare module "@cyrenex/pondi" {
 *   interface Registry { message: string }
 * }
 * ```
 */
// oxlint-disable-next-line no-empty-interface
export interface Registry {}

export type Mode = "singleton" | "scoped" | "transient";

export interface RippleOptions {
  /** @default "singleton" */
  mode?: Mode;
}

/** A typed contract identified by its string key. Has no implementation. */
export interface Pebble<T> {
  readonly key: string;
  /** Phantom field carrying the value type; absent at runtime. */
  readonly [TYPE]: T;
}

/** A pebble with an implementation. */
export interface Ripple<T> extends Pebble<T> {
  readonly deps: readonly Token[];
  readonly factory: (...args: any[]) => T | PromiseLike<T>;
  readonly mode: Mode;
  readonly [RIPPLE]: true;
}

export type Token = Pebble<any> | string;

/** String keys with autocomplete for registered ones, while still accepting any string. */
// oxlint-disable-next-line no-redundant-type-constituents
export type TokenInput = Pebble<any> | (keyof Registry & string) | (string & {});

type KeyValue<K extends string> = K extends keyof Registry ? Registry[K] : unknown;

export type Value<K> = K extends Pebble<infer T> ? T : K extends string ? KeyValue<K> : never;

export type Values<D extends readonly Token[]> = { -readonly [I in keyof D]: Value<D[I]> };

export type Factory<D extends readonly Token[], T> = (...args: Values<D>) => T | PromiseLike<T>;

export function pebble<T>(key: string): Pebble<T> {
  return Object.freeze({ key }) as Pebble<T>;
}

export function ripple<T>(
  pebble: Pebble<T>,
  factory: Factory<[], T>,
  options?: RippleOptions,
): Ripple<T>;
export function ripple<T, const D extends readonly Token[]>(
  pebble: Pebble<T>,
  deps: D,
  factory: Factory<D, T>,
  options?: RippleOptions,
): Ripple<T>;
export function ripple<K extends string, T extends KeyValue<K>>(
  key: K,
  factory: Factory<[], T>,
  options?: RippleOptions,
): Ripple<T>;
export function ripple<K extends string, const D extends readonly Token[], T extends KeyValue<K>>(
  key: K,
  deps: D,
  factory: Factory<D, T>,
  options?: RippleOptions,
): Ripple<T>;
export function ripple(
  target: Token,
  depsOrFactory: readonly Token[] | ((...args: any[]) => unknown),
  factoryOrOptions?: ((...args: any[]) => unknown) | RippleOptions,
  maybeOptions?: RippleOptions,
): Ripple<unknown> {
  const key = keyOf(target);
  let deps: readonly Token[];
  let factory: (...args: any[]) => unknown;
  let options: RippleOptions | undefined;
  if (typeof depsOrFactory === "function") {
    deps = [];
    factory = depsOrFactory;
    options = factoryOrOptions as RippleOptions | undefined;
  } else {
    deps = depsOrFactory;
    factory = factoryOrOptions as (...args: any[]) => unknown;
    options = maybeOptions;
  }
  if (typeof factory !== "function") {
    throw new TypeError(`ripple("${key}"): factory must be a function`);
  }
  const mode = options?.mode ?? "singleton";
  if (mode !== "singleton" && mode !== "scoped" && mode !== "transient") {
    throw new TypeError(`ripple("${key}"): unknown mode "${String(mode)}"`);
  }
  return Object.freeze({
    key,
    deps: Object.freeze([...deps]),
    factory,
    mode,
    [RIPPLE]: true,
  }) as unknown as Ripple<unknown>;
}

export type Constructor<D extends readonly Token[], T> = new (...args: Values<D>) => T;

function rippleClass<T>(
  pebble: Pebble<T>,
  cls: Constructor<[], T>,
  options?: RippleOptions,
): Ripple<T>;
function rippleClass<T, const D extends readonly Token[]>(
  pebble: Pebble<T>,
  deps: D,
  cls: Constructor<D, T>,
  options?: RippleOptions,
): Ripple<T>;
function rippleClass<K extends string, T extends KeyValue<K>>(
  key: K,
  cls: Constructor<[], T>,
  options?: RippleOptions,
): Ripple<T>;
function rippleClass<K extends string, const D extends readonly Token[], T extends KeyValue<K>>(
  key: K,
  deps: D,
  cls: Constructor<D, T>,
  options?: RippleOptions,
): Ripple<T>;
function rippleClass(
  target: Token,
  depsOrClass: readonly Token[] | (new (...args: any[]) => unknown),
  classOrOptions?: (new (...args: any[]) => unknown) | RippleOptions,
  maybeOptions?: RippleOptions,
): Ripple<unknown> {
  // Classes are functions too, so discriminate on the deps array instead.
  const [deps, cls, options] = Array.isArray(depsOrClass)
    ? [depsOrClass, classOrOptions as new (...args: any[]) => unknown, maybeOptions]
    : [[], depsOrClass as new (...args: any[]) => unknown, classOrOptions as RippleOptions];
  if (typeof cls !== "function") {
    throw new TypeError(`ripple.class("${keyOf(target)}"): expected a class`);
  }
  return ripple(target as string, deps, (...args: unknown[]) => new cls(...args), options);
}

/** Like `ripple`, but instantiates a class with the resolved dependencies as constructor arguments. */
ripple.class = rippleClass;

export function isRipple(value: unknown): value is Ripple<unknown> {
  return typeof value === "object" && value !== null && RIPPLE in value;
}

export function keyOf(token: Token): string {
  return typeof token === "string" ? token : token.key;
}
