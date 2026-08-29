// TypeScript 消费者门禁 fixture（6.3）：tsc --noEmit -p test/tsconfig.fixture.json。
// 覆盖 C0.2 契约：FabricOptions（httpProxy 三形态 / relay 判别联合）、Fabric 工厂
// 签名、on() 订阅 relay-* 事件 payload、relayStatus() 返回类型收窄、公共别名与
// deriveErrorCode 导入。
//
// activeUrl（8.2）：整合完成——.node 已重建、index.d.ts 已再生成（含 activeUrl），
// POST_INTEGRATION 已翻 true：事件/快照两处收窄断言与 HasActiveUrl 硬断言全部生效。

/** 整合开关：二进制与 d.ts 契约就位后为 true（收紧全部 activeUrl 断言）。 */
type POST_INTEGRATION = true;

import { deriveErrorCode, Fabric } from "../index.js";
import type {
  FabricEventJs,
  FabricOptions,
  HttpProxyOptions,
  RelayStatusJs,
} from "../index.js";

// ---- 公共别名导入（spec 场景：消费者 import { HttpProxyOptions }）----------------

const proxyNone: HttpProxyOptions = "none";
const proxyFromEnv: HttpProxyOptions = "from-env";
const proxyUrl: HttpProxyOptions = { url: "http://127.0.0.1:7890" };

// ---- FabricOptions：httpProxy 三形态 + relay 判别联合 ----------------------------

const optsNone: FabricOptions = {
  dataDir: "/tmp/dweb-a",
  relay: { mode: "n0" },
  httpProxy: proxyNone,
};
const optsEnv: FabricOptions = {
  dataDir: "/tmp/dweb-b",
  relay: { mode: "disabled" },
  httpProxy: proxyFromEnv,
};
const optsCustom: FabricOptions = {
  dataDir: "/tmp/dweb-c",
  relay: { mode: "custom", urls: ["https://relay1.example", "https://relay2.example"] },
  httpProxy: proxyUrl,
  advertiseAddrs: ["127.0.0.1:10000"],
  joinTimeoutMs: 60_000,
};
const optsDefault: FabricOptions = { dataDir: "/tmp/dweb-d" }; // 全缺省

// 非法形态必须编译失败（取消注释任一行即应红灯——契约的负向形态）：
// const badProxy: FabricOptions = { dataDir: "x", httpProxy: "socks5" };
// const badRelay: FabricOptions = { dataDir: "x", relay: { mode: "custom" } }; // 缺 urls
// const badRelayUrls: FabricOptions = { dataDir: "x", relay: { mode: "custom", urls: [] } }; // 空数组

// ---- Fabric 工厂签名 -------------------------------------------------------------

async function construct(): Promise<void> {
  const root = await Fabric.createRoot(optsNone);
  const opened = await Fabric.open(optsEnv);
  const attached = await Fabric.attach(optsCustom, "ab".repeat(32));
  const joined = await Fabric.joinWithToken(optsDefault, "dweb1.example-token");
  const fabricId: string = await root.fabricIdHex();
  const endpointId: string = root.endpointId;
  await Promise.all([root, opened, attached, joined].map((f) => f.shutdown()));
  void fabricId;
  void endpointId;
}

// ---- on() 订阅：relay-* 事件 payload（与 relayStatus() 同构）----------------------

function subscribe(fabric: Fabric): () => void {
  return fabric.on((ev: FabricEventJs) => {
    if (ev.type === "relay-online" || ev.type === "relay-offline") {
      const relay: RelayStatusJs = ev.relay;
      const mode: "disabled" | "custom" | "n0" = relay.mode;
      const urls: string[] = relay.urls;
      const online: boolean | null = relay.online;
      const lastError: string | null = relay.lastError;
      const activeUrl: string | null = relay.activeUrl;
      void mode;
      void urls;
      void online;
      void lastError;
      void activeUrl;
    }
    if (ev.type === "message") {
      const data: Buffer = ev.data;
      void data;
    }
  });
}

// ---- relayStatus() 返回类型收窄 ----------------------------------------------------

async function probe(fabric: Fabric): Promise<void> {
  const s = await fabric.relayStatus();
  const mode: "disabled" | "custom" | "n0" = s.mode;
  const urls: string[] = s.urls;
  const online: boolean | null = s.online;
  const lastError: string | null = s.lastError;
  const activeUrl: string | null = s.activeUrl;
  void mode;
  void urls;
  void online;
  void lastError;
  void activeUrl;
}

// ---- deriveErrorCode --------------------------------------------------------------

const code: string | null = deriveErrorCode("[relay-offline] connection lost");
void code;

// ---- activeUrl 契约硬断言（8.2，POST_INTEGRATION 门控）----------------------------

/** T 携带 activeUrl: string | null 才为 true */
type HasActiveUrl<T> = T extends { activeUrl: string | null } ? true : false;
/** 编译期断言：仅接受 true */
type ExpectTrue<T extends true> = T;

/** relay-online/offline 事件 payload 的 relay 快照类型 */
type RelayEventPayload = Extract<FabricEventJs, { type: "relay-online" | "relay-offline" }>["relay"];

type ActiveUrlOnStatus = POST_INTEGRATION extends true
  ? ExpectTrue<HasActiveUrl<RelayStatusJs>>
  : HasActiveUrl<RelayStatusJs>;
type ActiveUrlOnEvent = POST_INTEGRATION extends true
  ? ExpectTrue<HasActiveUrl<RelayEventPayload>>
  : HasActiveUrl<RelayEventPayload>;

// 整合后（POST_INTEGRATION = true）若 index.d.ts 缺 activeUrl 字段，
// ActiveUrlOnStatus / ActiveUrlOnEvent 将以 "Type 'false' does not satisfy the
// constraint 'true'" 编译失败——这就是收紧后的门禁。

export type { ActiveUrlOnEvent, ActiveUrlOnStatus };
