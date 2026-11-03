# @cyrenex/di

[English](./README.md) | 简体中文

以字符串为 key 的类型安全依赖注入库。不需要装饰器，也不依赖 `reflect-metadata`；支持异步工厂、异步初始化、分层容器和资源释放。

```ts
import { Cyrene, ripple, verse } from "@cyrenex/di";

interface AgentOptions {
  url: string;
}

// 契约：只有类型，没有实现
const AgentConfig = verse<AgentOptions>("agent:config");

// 插件：为契约提供实现
const agentConfigPlugin = (options: AgentOptions) => ripple(AgentConfig, () => options);

// 带默认实现的 token
const Message = ripple("message", () => "Hello, Cyrene!");

// 声明依赖，工厂参数的类型会自动推导
const Agent = ripple("agent", [Message, AgentConfig], async (message, config) => {
  const connection = await connect(config.url);
  return {
    send: () => connection.send(message),
    async [Symbol.asyncDispose]() {
      await connection.close();
    },
  };
});

await using app = new Cyrene().use(agentConfigPlugin({ url: "ws://localhost" }));
const agent = await app.resolve(Agent); // { send: () => void }
```

## 安装

```bash
pnpm add @cyrenex/di
```

## 核心概念

| 概念       | 说明                                                          |
| ---------- | ------------------------------------------------------------- |
| `verse<T>` | 契约：一个带类型的字符串 key，没有实现                        |
| `ripple`   | 实现：key + 依赖 + 工厂 + 生命周期模式，同时也可以当 token 用 |
| `Cyrene`   | 容器：注册实现、解析实例、管理生命周期                        |

**key 就是身份。** `ripple("message", ...)`、`verse("message")` 和字符串 `"message"` 指向同一个 token，`app.resolve(Message)` 与 `app.resolve("message")` 返回的是同一个实例。建议用命名空间来避免撞名，例如 `"agent:config"`。

## 声明 ripple

```ts
ripple(key, factory, options?)
ripple(key, deps, factory, options?)
ripple(verse, factory, options?)        // 为 verse 提供实现，返回值类型必须符合契约
ripple(verse, deps, factory, options?)
```

- `deps` 里可以混写 verse、ripple 和字符串，工厂按顺序收到解析好的值。
- 工厂可以是 async 的。解析时会 `await` 工厂，依赖方拿到的永远是值，不是 Promise。
- `options.mode` 默认是 `"singleton"`，见下文的[生命周期模式](#生命周期模式)。

### ripple.class

参数形式与 `ripple` 相同，只是把工厂换成 class，依赖会按顺序传给构造函数：

```ts
class Agent {
  constructor(
    readonly message: string,
    readonly config: AgentOptions,
  ) {}
}

const AgentRipple = ripple.class("agent", [Message, AgentConfig], Agent);
const Logger = ripple.class(LoggerVerse, ConsoleLogger);
```

构造函数参数和依赖列表的类型会在编译期校验，依赖顺序写错会直接报错。

## 解析与类型

```ts
await app.resolve(Agent); // 类型来自 ripple
await app.resolve(AgentConfig); // 类型来自 verse
await app.resolve("message"); // 类型来自 Registry，未声明时为 unknown
```

想让纯字符串 key 也带类型，可以扩展 `Registry`。扩展后字符串 key 会有自动补全，`ripple` 的返回值也会按这里的声明做校验：

```ts
declare module "@cyrenex/di" {
  interface Registry {
    message: string;
    "agent:config": AgentOptions;
  }
}
```

## 解析规则

解析一个 token 时，按以下顺序查找实现：

1. 当前容器及其所有父容器中通过 `use` 注册的实现，层级最近的优先。
2. 如果 token 本身是一个 ripple，就使用它自带的默认实现。
3. 都没有就抛出 `MISSING_PROVIDER`，错误里带有完整的依赖路径，例如 `agent -> agent:config`。

所以 ripple 不需要事先 `use` 就能直接 resolve；verse 和纯字符串则必须有某个容器提供实现。

## 注册与覆盖

### use

```ts
app.use(Message, agentConfigPlugin(opts), [PluginA, PluginB]); // 也接受数组，方便插件一次返回多个 ripple
```

- 同一个 ripple 对象重复 `use` 不会有任何效果。
- 同一个 key 注册不同的实现，会抛出 `DUPLICATE_PROVIDER`。
- 一个 key 被 resolve 过之后，就不能在当前容器及其祖先容器中再注册，否则抛出 `PROVIDER_LOCKED`。这是为了避免新旧实例同时存在。

### fork

覆盖实现只有一种方式：创建子容器，在子容器里注册同名 key。

```ts
await using test = app.fork().use(ripple("message", () => "mock"));

await test.resolve(Agent); // 使用 mock 版本的 message
await app.resolve(Agent); // 父容器不受影响
```

子容器中，**依赖被覆盖到的 singleton 会重新创建**，没被影响的 singleton 仍然和父容器共享同一个实例。具体来说，一个 singleton 会缓存在"它自身的实现以及所有传递依赖的实现"当中注册位置最深的那个容器里。

适用场景：测试 mock、请求级上下文、多租户、替换插件中的部分实现。

## 生命周期模式

| mode                | 实例缓存位置                 | 由谁释放       |
| ------------------- | ---------------------------- | -------------- |
| `singleton`（默认） | 按上面的规则自动确定的容器   | 缓存它的容器   |
| `scoped`            | 发起解析的容器，每个容器一份 | 该容器         |
| `transient`         | 不缓存，每次解析都新建       | 发起解析的容器 |

- singleton 直接或间接依赖 scoped 时会抛出 `CAPTIVE_DEPENDENCY`。
- 同一个 singleton 被并发解析时，工厂只会执行一次。
- 工厂或初始化失败的结果不会被缓存，下次解析会重试。

## 异步初始化与资源释放

```ts
import { asyncDispose, dispose, init } from "@cyrenex/di";

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

- **`init`**：实例创建后，容器会先 `await value[init]()`，完成后才把实例交给依赖方、写入缓存。它用来做构造函数里做不了的异步初始化。如果 `init` 抛错，容器会先释放这个实例，再抛出原错误。
- **`asyncDispose` / `dispose`**：就是标准的 `Symbol.asyncDispose` / `Symbol.dispose`。运行时不支持时会退回 `Symbol.for(...)`，可以直接配合 `await using` / `using` 使用。
- 以上机制对 `ripple` 工厂返回的对象和 `ripple.class` 创建的实例都有效。

释放容器时可以用 `await using`，也可以调用 `await app.dispose()`。释放顺序是：

1. 先释放所有子容器；
2. 再按创建顺序的逆序，释放当前容器持有的实例，也就是先释放依赖方，再释放被依赖的实例；
3. 多个释放错误会合并成一个 `AggregateError` 抛出。

容器释放后，再调用 `resolve`、`use` 或 `fork` 都会抛出 `DISPOSED`。

## 错误

所有容器错误都是 `CyreneError`，带有 `code` 和依赖路径 `path`：

| code                  | 触发条件                                  |
| --------------------- | ----------------------------------------- |
| `MISSING_PROVIDER`    | 找不到 key 的实现                         |
| `DUPLICATE_PROVIDER`  | 同一个容器里，同一个 key 注册了不同的实现 |
| `PROVIDER_LOCKED`     | key 已经被 resolve 过，又试图注册新的实现 |
| `CIRCULAR_DEPENDENCY` | 存在循环依赖                              |
| `CAPTIVE_DEPENDENCY`  | singleton 直接或间接依赖了 scoped         |
| `DISPOSED`            | 容器已释放                                |

```ts
try {
  await app.resolve(Agent);
} catch (error) {
  if (error instanceof CyreneError && error.code === "MISSING_PROVIDER") {
    console.error(error.path); // ["agent", "agent:config"]
  }
}
```

## 开发

```bash
vp install # 安装依赖
vp test    # 运行测试
vp check   # 格式、lint、类型检查
vp pack    # 构建
```

## License

MIT
