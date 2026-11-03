import { describe, expect, test } from "vite-plus/test";
import { asyncDispose, Cyrene, CyreneError, dispose, init, ripple, verse } from "../src/index.ts";

interface AgentOptions {
  url: string;
}

const AgentConfig = verse<AgentOptions>("agent:config");
const agentConfigPlugin = (options: AgentOptions) => ripple(AgentConfig, () => options);
const Message = ripple("message", () => "Hello, Cyrene!");

function connection(log: string[], name: string) {
  return {
    name,
    async [Symbol.asyncDispose]() {
      log.push(`close ${name}`);
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CyreneError ? error.code : undefined;
  }
  return undefined;
}

describe("resolve", () => {
  test("ripple acts as its own default provider", async () => {
    const app = new Cyrene();
    expect(await app.resolve(Message)).toBe("Hello, Cyrene!");
    expect(await app.resolve("message")).toBe("Hello, Cyrene!");
  });

  test("verse needs a provider and is satisfied by a plugin", async () => {
    const Agent = ripple("agent", [Message, AgentConfig], (message, config) => ({
      text: `${message} @ ${config.url}`,
    }));
    expect(await codeOf(new Cyrene().resolve(Agent))).toBe("MISSING_PROVIDER");

    const app = new Cyrene().use(agentConfigPlugin({ url: "ws://x" }));
    expect((await app.resolve(Agent)).text).toBe("Hello, Cyrene! @ ws://x");
  });

  test("missing provider error carries the dependency path", async () => {
    const Agent = ripple("agent", [AgentConfig], (c) => c);
    const error = await new Cyrene().resolve(Agent).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CyreneError);
    expect((error as CyreneError).path).toEqual(["agent", "agent:config"]);
  });

  test("string dependencies resolve by key", async () => {
    const Greeting = ripple("greeting", ["message"], (m) => `${String(m)}!`);
    const app = new Cyrene().use(Message);
    expect(await app.resolve(Greeting)).toBe("Hello, Cyrene!!");
  });

  test("async factories and concurrent singleton resolution", async () => {
    let created = 0;
    const Slow = ripple("slow", async () => {
      created++;
      await new Promise((r) => setTimeout(r, 5));
      return { id: created };
    });
    const app = new Cyrene();
    const [a, b] = await Promise.all([app.resolve(Slow), app.resolve(Slow)]);
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  test("failed factory is retried on next resolve", async () => {
    let attempt = 0;
    const Flaky = ripple("flaky", () => {
      if (++attempt === 1) throw new Error("boom");
      return attempt;
    });
    const app = new Cyrene();
    await expect(app.resolve(Flaky)).rejects.toThrow("boom");
    expect(await app.resolve(Flaky)).toBe(2);
  });

  test("detects circular dependencies", async () => {
    const A: ReturnType<typeof ripple> = ripple("a", ["b"], () => 1);
    const B = ripple("b", [A], () => 2);
    const app = new Cyrene().use(B);
    const error = (await app.resolve(A).catch((e: unknown) => e)) as CyreneError;
    expect(error.code).toBe("CIRCULAR_DEPENDENCY");
    expect(error.path).toEqual(["a", "b", "a"]);
  });
});

describe("modes", () => {
  test("transient creates a new instance per resolve", async () => {
    const T = ripple("t", () => ({}), { mode: "transient" });
    const app = new Cyrene();
    expect(await app.resolve(T)).not.toBe(await app.resolve(T));
  });

  test("scoped is shared within a container but not across forks", async () => {
    const S = ripple("s", () => ({}), { mode: "scoped" });
    const app = new Cyrene();
    const child = app.fork();
    expect(await child.resolve(S)).toBe(await child.resolve(S));
    expect(await child.resolve(S)).not.toBe(await app.resolve(S));
  });

  test("singleton is shared with forks when unaffected by shadowing", async () => {
    const Single = ripple("single", () => ({}));
    const app = new Cyrene();
    expect(await app.fork().resolve(Single)).toBe(await app.resolve(Single));
  });

  test("singleton depending on scoped is rejected", async () => {
    const S = ripple("s", () => 1, { mode: "scoped" });
    const T = ripple("t", [S], (s) => s, { mode: "transient" });
    const Single = ripple("single", [T], (t) => t);
    expect(await codeOf(new Cyrene().resolve(Single))).toBe("CAPTIVE_DEPENDENCY");
  });

  test("scoped may depend on scoped and transient", async () => {
    const S = ripple("s", () => 1, { mode: "scoped" });
    const T = ripple("t", [S], (s) => s + 1, { mode: "transient" });
    const S2 = ripple("s2", [T], (t) => t + 1, { mode: "scoped" });
    expect(await new Cyrene().resolve(S2)).toBe(3);
  });
});

describe("use and fork", () => {
  test("same ripple twice is a no-op, a different one throws", () => {
    const app = new Cyrene().use(Message, [Message]);
    expect(() => app.use(ripple("message", () => "other"))).toThrow(CyreneError);
  });

  test("cannot provide a key after it was resolved", async () => {
    const app = new Cyrene();
    await app.resolve(Message);
    expect(() => app.use(ripple("message", () => "late"))).toThrow(/already been resolved/);
  });

  test("fork shadows providers and rebuilds affected singletons", async () => {
    const Agent = ripple("agent", [Message, AgentConfig], (m, c) => ({ text: `${m}@${c.url}` }));
    const Other = ripple("other", [AgentConfig], (c) => ({ url: c.url }));
    const app = new Cyrene().use(agentConfigPlugin({ url: "prod" }));

    const prodAgent = await app.resolve(Agent);
    const prodOther = await app.resolve(Other);

    const test = app.fork().use(ripple("message", () => "mock"));
    const testAgent = await test.resolve(Agent);
    expect(testAgent.text).toBe("mock@prod");
    expect(testAgent).not.toBe(prodAgent);
    // Not affected by the shadowed key, so still shared.
    expect(await test.resolve(Other)).toBe(prodOther);
    // Parent is untouched.
    expect(await app.resolve(Agent)).toBe(prodAgent);
  });

  test("parent cannot provide a key a child already resolved", async () => {
    const app = new Cyrene();
    await app.fork().resolve(Message);
    expect(() => app.use(ripple("message", () => "late"))).toThrow(CyreneError);
  });
});

describe("dispose", () => {
  test("disposes instances in reverse creation order", async () => {
    const log: string[] = [];
    const Db = ripple("db", () => connection(log, "db"));
    const Repo = ripple("repo", [Db], () => connection(log, "repo"));
    const Service = ripple("service", [Repo], () => connection(log, "service"));
    {
      await using app = new Cyrene();
      await app.resolve(Service);
    }
    expect(log).toEqual(["close service", "close repo", "close db"]);
  });

  test("fork disposes only what it owns; parent disposes children first", async () => {
    const log: string[] = [];
    const Db = ripple("db", () => connection(log, "db"));
    const Session = ripple("session", [Db], () => connection(log, "session"), { mode: "scoped" });
    const Temp = ripple("temp", () => connection(log, "temp"), { mode: "transient" });

    const app = new Cyrene();
    const req = app.fork();
    await req.resolve(Session);
    await req.resolve(Temp);
    await req.dispose();
    expect(log).toEqual(["close temp", "close session"]);

    const req2 = app.fork();
    await req2.resolve(Session);
    await app.dispose();
    expect(log).toEqual(["close temp", "close session", "close session", "close db"]);
  });

  test("supports sync Symbol.dispose and aggregates errors", async () => {
    const log: string[] = [];
    const A = ripple("a", () => ({
      [Symbol.dispose]() {
        log.push("a");
      },
    }));
    const B = ripple("b", () => ({
      [Symbol.dispose]() {
        throw new Error("b failed");
      },
    }));
    const C = ripple("c", () => ({
      async [Symbol.asyncDispose]() {
        throw new Error("c failed");
      },
    }));
    const app = new Cyrene();
    await app.resolve(A);
    await app.resolve(B);
    await app.resolve(C);
    const error = await app.dispose().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(log).toEqual(["a"]);
  });

  test("disposed container rejects further use", async () => {
    const app = new Cyrene();
    await app.dispose();
    expect(await codeOf(app.resolve(Message))).toBe("DISPOSED");
    expect(() => app.fork()).toThrow(CyreneError);
    expect(app.dispose()).toBe(app.dispose());
  });
});

describe("ripple.class", () => {
  test("instantiates with resolved dependencies and disposes", async () => {
    const log: string[] = [];
    class Agent {
      constructor(
        readonly message: string,
        readonly config: AgentOptions,
      ) {}
      async [Symbol.asyncDispose]() {
        log.push("agent closed");
      }
    }
    const AgentRipple = ripple.class("agent", [Message, AgentConfig], Agent);
    const Plain = ripple.class("plain", class {}, { mode: "transient" });
    {
      await using app = new Cyrene().use(agentConfigPlugin({ url: "ws://x" }));
      const agent = await app.resolve(AgentRipple);
      expect(agent).toBeInstanceOf(Agent);
      expect(agent.message).toBe("Hello, Cyrene!");
      expect(agent.config.url).toBe("ws://x");
      expect(await app.resolve(Plain)).not.toBe(await app.resolve(Plain));
    }
    expect(log).toEqual(["agent closed"]);
  });

  test("implements a verse", async () => {
    interface Logger {
      log(msg: string): string;
    }
    const LoggerVerse = verse<Logger>("logger");
    class ConsoleLogger implements Logger {
      log(msg: string) {
        return `[log] ${msg}`;
      }
    }
    const app = new Cyrene().use(ripple.class(LoggerVerse, ConsoleLogger));
    expect((await app.resolve(LoggerVerse)).log("hi")).toBe("[log] hi");
  });
});

describe("lifecycle symbols", () => {
  test("aliases are the standard symbols", () => {
    expect(asyncDispose).toBe(Symbol.asyncDispose);
    expect(dispose).toBe(Symbol.dispose);
  });

  test("init is awaited before the instance reaches dependents", async () => {
    const log: string[] = [];
    class Db {
      ready = false;
      async [init]() {
        await new Promise((r) => setTimeout(r, 5));
        this.ready = true;
        log.push("db init");
      }
      async [asyncDispose]() {
        log.push("db close");
      }
    }
    const DbRipple = ripple.class("db", Db);
    const Repo = ripple("repo", [DbRipple], (db) => {
      log.push(`repo sees ready=${db.ready}`);
      return { db };
    });
    {
      await using app = new Cyrene();
      const [a, b] = await Promise.all([app.resolve(Repo), app.resolve(DbRipple)]);
      expect(a.db).toBe(b);
    }
    expect(log).toEqual(["db init", "repo sees ready=true", "db close"]);
  });

  test("failed init disposes the instance, is not cached, and can be retried", async () => {
    const log: string[] = [];
    let attempt = 0;
    class Conn {
      readonly id = ++attempt;
      [init]() {
        if (this.id === 1) throw new Error("init failed");
      }
      [dispose]() {
        log.push(`dispose ${this.id}`);
      }
    }
    const app = new Cyrene();
    const ConnRipple = ripple.class("conn", Conn);
    await expect(app.resolve(ConnRipple)).rejects.toThrow("init failed");
    expect(log).toEqual(["dispose 1"]);
    expect((await app.resolve(ConnRipple)).id).toBe(2);
    await app.dispose();
    expect(log).toEqual(["dispose 1", "dispose 2"]);
  });

  test("init works with plain factories too", async () => {
    const Svc = ripple("svc", () => {
      const svc = {
        started: false,
        async [init]() {
          svc.started = true;
        },
      };
      return svc;
    });
    expect((await new Cyrene().resolve(Svc)).started).toBe(true);
  });
});
