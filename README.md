<h1 align="center">pondi</h1>

<p align="center">Drop a pebble, get a ripple. Type-safe, string-keyed dependency injection for TypeScript.</p>

<p align="center">
  [<a href="https://github.com/cyrenex/pondi/blob/master/README.zh-CN.md">简体中文</a>] [<a href="https://www.npmjs.com/package/@cyrenex/pondi">npm</a>]
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cyrenex/pondi"><img src="https://img.shields.io/npm/v/@cyrenex/pondi?style=flat&colorA=080f12&colorB=1fa669"></a>
  <a href="https://www.npmjs.com/package/@cyrenex/pondi"><img src="https://img.shields.io/npm/dm/@cyrenex/pondi?style=flat&colorA=080f12&colorB=1fa669"></a>
  <a href="https://bundlejs.com/?q=@cyrenex/pondi"><img src="https://deno.bundlejs.com/badge?q=@cyrenex/pondi&badge=detailed&badge-style=flat"></a>
  <a href="https://github.com/cyrenex/pondi/blob/master/LICENSE"><img src="https://img.shields.io/github/license/cyrenex/pondi.svg?style=flat&colorA=080f12&colorB=1fa669"></a>
</p>

> [!NOTE]
> No decorators, no `reflect-metadata`, no runtime dependencies. Just keys, factories, and types.

Most DI containers in TypeScript lean on decorators and emitted metadata, and you pay for that with build configuration and a class-only style. pondi goes the other way: **a dependency is a string key with a type attached**. You declare what you need with a `pebble`, describe how to build it with a `ripple`, and let a `Pond` wire everything together.

Think of it as dropping a pebble into a pond: the pebble names what you need, the ripple is what it becomes.

## What's Special

- **Inferred types everywhere**: factory parameters are inferred from the dependency list, and wrong orders or shapes fail at compile time.
- **Async all the way**: async factories, async `init` hooks, and concurrent resolves that run each factory only once.
- **Hierarchical ponds**: `fork()` a child to override providers for tests, requests, or tenants; only the affected singletons are rebuilt.
- **Deterministic disposal**: works with `await using`; children first, then instances in reverse creation order.
- **Helpful errors**: every `PondError` carries a `code` and the full dependency `path`.

## Installation

```bash
pnpm add @cyrenex/pondi
```

## Quick Start

```ts
import { pebble, Pond, ripple } from "@cyrenex/pondi";

interface AgentOptions {
  url: string;
}

// A contract: a type, no implementation
const AgentConfig = pebble<AgentOptions>("agent:config");

// A plugin: provides an implementation for the contract
const agentConfigPlugin = (options: AgentOptions) => ripple(AgentConfig, () => options);

// A token with a default implementation
const Message = ripple("message", () => "Hello, Pond!");

// Declare dependencies; factory parameter types are inferred
const Agent = ripple("agent", [Message, AgentConfig], async (message, config) => {
  const connection = await connect(config.url);
  return {
    send: () => connection.send(message),
    async [Symbol.asyncDispose]() {
      await connection.close();
    },
  };
});

await using app = new Pond().use(agentConfigPlugin({ url: "ws://localhost" }));
const agent = await app.resolve(Agent); // { send: () => void }
```

## Core Concepts

| Concept     | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| `pebble<T>` | A contract: a typed string key with no implementation                          |
| `ripple`    | An implementation: key + dependencies + factory + mode; also usable as a token |
| `Pond`      | The container: registers implementations, resolves instances, owns lifecycles  |

**The key is the identity.** `ripple("message", ...)`, `pebble("message")`, and the string `"message"` all refer to the same token, so `app.resolve(Message)` and `app.resolve("message")` return the same instance. Namespace your keys to avoid collisions, e.g. `"agent:config"`.

## Declaring Ripples

```ts
ripple(key, factory, options?)
ripple(key, deps, factory, options?)
ripple(pebble, factory, options?)        // implements a pebble; the return type must match the contract
ripple(pebble, deps, factory, options?)
```

- `deps` may mix pebbles, ripples, and strings. The factory receives the resolved values in order.
- Factories may be async. The container awaits them, so dependents always receive values, never promises.
- `options.mode` defaults to `"singleton"`. See [Lifecycle Modes](#lifecycle-modes).
- `ripple.scoped(...)` and `ripple.transient(...)` are shorthands for `ripple(..., { mode: "scoped" })` and `ripple(..., { mode: "transient" })`. They take the same arguments as `ripple`, minus `options`. Class variants are `ripple.scoped.class(...)` and `ripple.transient.class(...)`.

### ripple.class

Same signatures as `ripple`, but takes a class instead of a factory. Dependencies are passed to the constructor in order:

```ts
class Agent {
  constructor(
    readonly message: string,
    readonly config: AgentOptions,
  ) {}
}

const AgentRipple = ripple.class("agent", [Message, AgentConfig], Agent);
const Logger = ripple.class(LoggerPebble, ConsoleLogger);
```

Constructor parameters are type-checked against the dependency list at compile time, so listing dependencies in the wrong order is an error.

## Resolving and Types

```ts
await app.resolve(Agent); // typed by the ripple
await app.resolve(AgentConfig); // typed by the pebble
await app.resolve("message"); // typed by Registry, or unknown if not declared
```

To give plain string keys a type, augment `Registry`. Augmented keys get autocompletion, and `ripple` checks its return type against the declaration:

```ts
declare module "@cyrenex/pondi" {
  interface Registry {
    message: string;
    "agent:config": AgentOptions;
  }
}
```

## Resolution Rules

To resolve a token, the container looks for an implementation in this order:

1. Implementations registered with `use` in the current container or any ancestor; the nearest one wins.
2. If the token itself is a ripple, its own default implementation.
3. Otherwise it throws `MISSING_PROVIDER`, with the full dependency path, e.g. `agent -> agent:config`.

So a ripple can be resolved without calling `use` first. Pebbles and plain strings need some container to provide them.

## Registering and Overriding

### use

```ts
app.use(Message, agentConfigPlugin(opts), [PluginA, PluginB]); // arrays are accepted, so plugins can return several ripples
```

- Registering the same ripple object again has no effect.
- Registering a different implementation for an existing key throws `DUPLICATE_PROVIDER`.
- Once a key has been resolved, it can no longer be registered in that container or its ancestors (`PROVIDER_LOCKED`). This prevents old and new instances from coexisting.

### fork

There is one way to override an implementation: create a child container and register the same key in it.

```ts
await using test = app.fork().use(ripple("message", () => "mock"));

await test.resolve(Agent); // uses the mocked message
await app.resolve(Agent); // the parent is unaffected
```

In the child, **singletons affected by an override are rebuilt**, while unaffected singletons stay shared with the parent. Precisely: a singleton is cached in the deepest container that provides it or any of its transitive dependencies.

Use cases: test mocks, request-scoped context, multi-tenancy, replacing part of a plugin.

## Lifecycle Modes

| mode                  | Where instances are cached                 | Disposed by              |
| --------------------- | ------------------------------------------ | ------------------------ |
| `singleton` (default) | The container chosen by the rule above     | The container caching it |
| `scoped`              | The resolving container, one per container | That container           |
| `transient`           | Not cached; a new instance per resolve     | The resolving container  |

- A singleton that depends on a scoped provider, directly or transitively, throws `CAPTIVE_DEPENDENCY`.
- Concurrent resolves of the same singleton run the factory only once.
- Failed factories or initializations are not cached; the next resolve retries.

## Async Initialization and Disposal

```ts
import { asyncDispose, dispose, init } from "@cyrenex/pondi";

class Db {
  #conn!: Connection;
  constructor(readonly config: DbConfig) {}

  async [init]() {
    this.#conn = await connect(this.config.url);
  }

  async [asyncDispose]() {
    await this.#conn.close();
  }
}
```

- **`init`**: after creating an instance, the container awaits `value[init]()` before handing it to dependents or caching it. Use it for async setup a constructor can't do. If `init` throws, the container disposes the instance and rethrows the original error.
- **`asyncDispose` / `dispose`**: the standard `Symbol.asyncDispose` / `Symbol.dispose`, falling back to `Symbol.for(...)` on runtimes that lack them. They work with `await using` / `using`.
- Both apply to objects returned by `ripple` factories and to instances created by `ripple.class`.

Dispose a container with `await using` or `await app.dispose()`. Disposal order:

1. Child containers first.
2. Then instances owned by this container, in reverse creation order, so dependents are disposed before their dependencies.
3. Multiple disposal errors are combined into one `AggregateError`.

After disposal, `resolve`, `use`, and `fork` throw `DISPOSED`.

## Errors

All container errors are `PondError` instances with a `code` and a dependency `path`:

| code                  | Thrown when                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `MISSING_PROVIDER`    | No implementation exists for a key                                  |
| `DUPLICATE_PROVIDER`  | A different implementation is registered for a key in one container |
| `PROVIDER_LOCKED`     | Registering an implementation for a key that was already resolved   |
| `CIRCULAR_DEPENDENCY` | Dependencies form a cycle                                           |
| `CAPTIVE_DEPENDENCY`  | A singleton depends on a scoped provider, directly or transitively  |
| `DISPOSED`            | The container has been disposed                                     |

```ts
try {
  await app.resolve(Agent);
} catch (error) {
  if (error instanceof PondError && error.code === "MISSING_PROVIDER") {
    console.error(error.path); // ["agent", "agent:config"]
  }
}
```

## Development

```bash
vp install # install dependencies
vp test    # run tests
vp check   # format, lint, and type check
vp pack    # build
vp run changeset # describe a change for the next release
```

## License

[MIT](./LICENSE)

## Special Thanks

Thanks to all contributors for their contributions to pondi ❤️

<a href="https://github.com/cyrenex/pondi/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=cyrenex/pondi" />
</a>

## Star History

<a href="https://star-history.dera.page/#cyrenex/pondi&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=cyrenex/pondi&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=cyrenex/pondi&type=Date" />
    <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=cyrenex/pondi&type=Date" />
  </picture>
</a>
