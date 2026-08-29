# C0.2 — client-sdk d.ts 契约增量（hardening-backlog，ZCode 冻结）

> 基线：archive/2026-08-28-connectivity-ux-hardening/contracts/client-sdk.d.ts.md（C0.1）。
> 本文件只冻结**变更面**；未标注处逐字沿用 C0.1。实现方（SDK batch）以 fix-dts.mjs
> 变换 + napi 再生成落实，index.d.ts 生成物必须与本增量一致。

## 1. RelayStatusJs 增加 activeUrl（task 8）

```ts
export interface RelayStatusJs {
  mode: 'disabled' | 'custom' | 'n0'
  urls: string[]
  online: boolean | null
  lastError: string | null
  /** [NEW] 配置序最小的已连接 relay URL；online !== true 或 disabled 时为 null。
   *  tie-break：同时连上多个 relay 时取配置序最小者（内核 aggregate_relay_status
   *  既有 online_url 逻辑，无新语义）。 */
  activeUrl: string | null
}
```

- `urls` / `activeUrl` 为**配置原样字符串**（R2 P1-4：不做尾斜杠规范化改写；
  聚合匹配在内核内部用归一化键）。
- `n0` 模式的 `urls` 为 **iroh 上游默认 relay 列表**（4 个区域节点，排序冻结，
  R3 P1-4）——与实际拨号一致；`activeUrl` 必落在 `urls` 内。
- `relayStatus()` 返回值与 `relay-online` / `relay-offline` 事件 payload 同构。
  **事件携带跳变时刻的完整快照副本**（R3 P1-2：消费侧不事后读共享可变快照；
  方法路径 index.js 包装 `?? null` 归一 napi 的 undefined）。
- 消费方（example chat）显示 `relay: online (<activeUrl>)`；activeUrl 为
  undefined（旧二进制）时回退候选数显示（feature-detect，非兼容承诺）。

## 2. FabricOptions.httpProxy 引用 alias（task 6）

```ts
export type HttpProxyOptions = 'none' | 'from-env' | { url: string }

export interface FabricOptions {
  // [CHANGED] 内联联合 → 引用已导出 alias（语义不变，消除重复声明）
  httpProxy?: HttpProxyOptions
  // ...
}
```

- `HttpProxyUrl` interface（C0.1 注入的 `{ url }` 形态说明块）**删除**
  （task 6.2：alias 已完整表达三形态，独立 interface 属冗余契约面）。

## 3. off() 兼容声明收口（task 7）

- index.js 头部声明：SDK 仅支持 v0.2+ 原生二进制；off() 在旧二进制缺失时的
  feature-detect no-op 是防御性降级，不是兼容承诺。

## 4. TypeScript 消费者门禁（task 6.3）

- `packages/client-sdk/test/types.fixture`（tsc --noEmit，strict）必须覆盖：
  httpProxy 三形态、relay-online 事件 payload.activeUrl 读取、
  relayStatus() 返回类型收窄（activeUrl: string | null）。
