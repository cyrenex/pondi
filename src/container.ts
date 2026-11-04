import { PondError } from "./errors.ts";
import { asyncDispose, disposeValue, initValue, isDisposable } from "./lifecycle.ts";
import { isRipple, keyOf } from "./token.ts";
import type { Mode, Ripple, Token, TokenInput, Value } from "./token.ts";

interface Info {
  provider: Ripple<unknown>;
  /** Index into the container chain where a singleton instance lives. */
  home: number;
  /** Whether the instance (transitively) depends on a scoped provider. */
  scoped: boolean;
}

export class Pond implements AsyncDisposable {
  #parent: Pond | undefined;
  /** Containers from root to this one. */
  #chain: Pond[] = [this];
  readonly #children = new Set<Pond>();
  readonly #registry = new Map<string, Ripple<unknown>>();
  /** Keys whose provider resolution is fixed because something resolved them through this container. */
  readonly #locked = new Set<string>();
  readonly #analysis = new Map<string, Info>();
  readonly #cache = new Map<string, Promise<unknown>>();
  /** Created instances in creation order, disposed in reverse. */
  readonly #instances: unknown[] = [];
  #disposing: Promise<void> | undefined;

  get #depth(): number {
    return this.#chain.length - 1;
  }

  /**
   * Register providers in this container. Accepts ripples or arrays of ripples (e.g. from plugins).
   * Registering the same ripple twice is a no-op; a different ripple for an existing key throws.
   * Use `fork()` to shadow a provider from a parent container.
   */
  use(...items: (Ripple<any> | readonly Ripple<any>[])[]): this {
    this.#assertAlive();
    for (const item of items.flat()) {
      if (!isRipple(item)) {
        throw new TypeError("Pond.use() expects ripples");
      }
      this.#register(item);
    }
    return this;
  }

  /** Create a child container. Its `use()` may shadow providers of this container. */
  fork(): Pond {
    this.#assertAlive();
    const child = new Pond();
    child.#parent = this;
    child.#chain = [...this.#chain, child];
    this.#children.add(child);
    return child;
  }

  resolve<K extends TokenInput>(token: K): Promise<Value<K>> {
    try {
      return this.#resolve(token) as Promise<Value<K>>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Dispose child containers, then owned instances in reverse creation order. */
  [asyncDispose](): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  dispose(): Promise<void> {
    return this[asyncDispose]();
  }

  #register(provider: Ripple<unknown>): void {
    const existing = this.#registry.get(provider.key);
    if (existing === provider) return;
    if (this.#locked.has(provider.key)) {
      throw new PondError(
        "PROVIDER_LOCKED",
        `"${provider.key}" has already been resolved through this container and can no longer be provided here`,
      );
    }
    if (existing) {
      throw new PondError(
        "DUPLICATE_PROVIDER",
        `A different provider for "${provider.key}" is already registered in this container; use fork() to shadow it`,
      );
    }
    this.#registry.set(provider.key, provider);
  }

  #lookup(token: Token, path: readonly string[]): { provider: Ripple<unknown>; depth: number } {
    const key = keyOf(token);
    for (let depth = this.#depth; depth >= 0; depth--) {
      const provider = this.#chain[depth]!.#registry.get(key);
      if (provider) return { provider, depth };
    }
    if (isRipple(token)) {
      // A ripple used directly acts as its own default provider, registered at the root.
      this.#chain[0]!.#registry.set(key, token);
      return { provider: token, depth: 0 };
    }
    throw new PondError("MISSING_PROVIDER", `No provider for "${key}"`, [...path, key]);
  }

  /** Statically walk the dependency graph to find providers, cycles, and singleton homes. */
  #analyze(token: Token, path: string[]): Info {
    const key = keyOf(token);
    const memo = this.#analysis.get(key);
    if (memo) return memo;
    if (path.includes(key)) {
      throw new PondError("CIRCULAR_DEPENDENCY", `Circular dependency on "${key}"`, [...path, key]);
    }
    const { provider, depth } = this.#lookup(token, path);
    path.push(key);
    const deps = provider.deps.map((dep) => this.#analyze(dep, path));
    path.pop();

    let info: Info;
    const mode: Mode = provider.mode;
    if (mode === "scoped") {
      info = { provider, home: this.#depth, scoped: true };
    } else {
      const scopedDep = deps.find((d) => d.scoped);
      if (mode === "singleton" && scopedDep) {
        throw new PondError(
          "CAPTIVE_DEPENDENCY",
          `Singleton "${key}" cannot depend on scoped "${scopedDep.provider.key}"`,
          [...path, key],
        );
      }
      const home = Math.max(depth, ...deps.map((d) => d.home));
      info = { provider, home, scoped: scopedDep !== undefined };
    }

    for (const c of this.#chain) c.#locked.add(key);
    this.#analysis.set(key, info);
    return info;
  }

  #resolve(token: Token): Promise<unknown> {
    this.#assertAlive();
    const { provider, home } = this.#analyze(token, []);
    if (provider.mode === "transient") {
      return this.#instantiate(provider);
    }
    const target = provider.mode === "singleton" ? this.#chain[home]! : this;
    // Resolving from a deeper container may land on an owner whose analysis is not done yet.
    if (target !== this) return target.#resolve(token);

    const cached = this.#cache.get(provider.key);
    if (cached) return cached;
    const pending = this.#instantiate(provider);
    this.#cache.set(provider.key, pending);
    pending.catch(() => {
      if (this.#cache.get(provider.key) === pending) this.#cache.delete(provider.key);
    });
    return pending;
  }

  async #instantiate(provider: Ripple<unknown>): Promise<unknown> {
    const args = await Promise.all(provider.deps.map((dep) => this.#resolve(dep)));
    const value = await provider.factory(...args);
    await initValue(value);
    if (this.#disposing) {
      await disposeValue(value);
      throw new PondError("DISPOSED", `Container was disposed while creating "${provider.key}"`);
    }
    if (isDisposable(value)) this.#instances.push(value);
    return value;
  }

  async #dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const child of [...this.#children].reverse()) {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    // Let in-flight creations settle so they are either tracked or self-disposed.
    await Promise.allSettled(this.#cache.values());
    for (const value of this.#instances.reverse()) {
      try {
        await disposeValue(value);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#instances.length = 0;
    this.#cache.clear();
    this.#analysis.clear();
    if (this.#parent) this.#parent.#children.delete(this);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose Pond container");
  }

  #assertAlive(): void {
    if (this.#disposing) throw new PondError("DISPOSED", "Container has been disposed");
  }
}
