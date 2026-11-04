import { expectTypeOf, test } from "vite-plus/test";
import { asyncDispose, dispose, pebble, Pond, ripple } from "../src/index.ts";
import type { Ripple } from "../src/index.ts";

declare module "../src/token.ts" {
  interface Registry {
    "typed:count": number;
  }
}

interface AgentOptions {
  url: string;
}

test("factory parameters are inferred from mixed dependencies", () => {
  const AgentConfig = pebble<AgentOptions>("agent:config");
  const Message = ripple("message", () => "hi");
  const Count = ripple("typed:count", async () => 1);

  const Agent = ripple("agent", [Message, AgentConfig, "typed:count", "untyped"], (m, c, n, u) => {
    expectTypeOf(m).toEqualTypeOf<string>();
    expectTypeOf(c).toEqualTypeOf<AgentOptions>();
    expectTypeOf(n).toEqualTypeOf<number>();
    expectTypeOf(u).toEqualTypeOf<unknown>();
    return { send: () => m };
  });

  expectTypeOf(Count).toEqualTypeOf<Ripple<number>>();
  expectTypeOf(ripple(AgentConfig, () => ({ url: "x" }))).toEqualTypeOf<Ripple<AgentOptions>>();

  // Type-only: never invoked at runtime.
  const _check = (app: Pond) => {
    expectTypeOf(app.resolve(Agent)).resolves.toEqualTypeOf<{ send: () => string }>();
    expectTypeOf(app.resolve(AgentConfig)).resolves.toEqualTypeOf<AgentOptions>();
    expectTypeOf(app.resolve("typed:count")).resolves.toEqualTypeOf<number>();
    expectTypeOf(app.resolve("anything")).resolves.toEqualTypeOf<unknown>();
  };
  void _check;
});

test("implementations must match their contract", () => {
  const AgentConfig = pebble<AgentOptions>("agent:config");
  // @ts-expect-error wrong shape for the pebble
  ripple(AgentConfig, () => ({ url: 1 }));
  // @ts-expect-error registry says number
  ripple("typed:count", () => "nope");
});

test("ripple.class checks constructor parameters against dependencies", () => {
  const AgentConfig = pebble<AgentOptions>("agent:config");
  const Message = ripple("message", () => "hi");
  class Agent {
    constructor(
      readonly message: string,
      readonly config: AgentOptions,
    ) {}
  }
  expectTypeOf(ripple.class("agent", [Message, AgentConfig], Agent)).toEqualTypeOf<Ripple<Agent>>();
  expectTypeOf(
    ripple.class(
      AgentConfig,
      class {
        url = "x";
      },
    ),
  ).toEqualTypeOf<Ripple<AgentOptions>>();
  // @ts-expect-error dependency order does not match constructor
  ripple.class("agent", [AgentConfig, Message], Agent);
  class BadConfig {
    url = 1;
  }
  // @ts-expect-error class does not satisfy the pebble
  ripple.class(AgentConfig, BadConfig);
});

test("lifecycle aliases type as the standard symbols", () => {
  class Res {
    async [asyncDispose]() {}
  }
  class SyncRes {
    [dispose]() {}
  }
  expectTypeOf<Res>().toExtend<AsyncDisposable>();
  expectTypeOf<SyncRes>().toExtend<Disposable>();
  expectTypeOf<Pond>().toExtend<AsyncDisposable>();
});
