#!/usr/bin/env node
// @dweb/example：dweb 组网示例 CLI。
// 线性最小实现（无框架），作为开发者接入 @jixo/opendweb-client-sdk 的参考样板。
// 用法：
//   dweb-example init [--data <dir>]
//   dweb-example id [--data <dir>]
//   dweb-example info
//   dweb-example invite [--ttl <ms>] [--for <endpointId>]
//   dweb-example join <token>
//   dweb-example members
//   dweb-example connect <endpointId>
//   dweb-example send <endpointId> <text...>
//   dweb-example chat
//   dweb-example name <display>
//   dweb-example revoke <endpointId>
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Fabric } = require("@jixo/opendweb-client-sdk");

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function opt(name, fallback = undefined) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

// 位置参数：剔除 --opt value 对
const positionals = args.slice(1).filter((a, i, arr) => {
  if (a.startsWith("--")) return false;
  if (i > 0 && arr[i - 1]?.startsWith("--")) return false;
  return true;
});

const dataDir = path.resolve(
  opt("--data") ?? process.env.DWEB_DATA ?? path.join(os.homedir(), ".dweb-example"),
);
fs.mkdirSync(dataDir, { recursive: true });

const relayMode = process.env.DWEB_RELAY ?? "disabled";
const relayUrls = process.env.DWEB_RELAY_URLS ? process.env.DWEB_RELAY_URLS.split(",") : undefined;
const baseOpts = {
  dataDir,
  relay: { mode: relayMode, urls: relayUrls },
};

function shortId(id) {
  return id.slice(0, 8);
}

async function openFabric() {
  const rosterExists = fs.existsSync(path.join(dataDir, "roster.facts"));
  if (!rosterExists) {
    throw new Error(`数据目录 ${dataDir} 不是已初始化的 fabric；先运行 init 或 join`);
  }
  return Fabric.open(baseOpts);
}

async function main() {
  switch (command) {
    case "init": {
      const fabric = await Fabric.createRoot(baseOpts);
      console.log(`fabric initialized`);
      console.log(`  endpoint-id : ${fabric.endpointId}`);
      console.log(`  fabric-id   : ${await fabric.fabricIdHex()}`);
      console.log(`  data-dir    : ${dataDir}`);
      await fabric.shutdown();
      break;
    }
    case "id": {
      const fabric = await openFabric();
      console.log(fabric.endpointId);
      await fabric.shutdown();
      break;
    }
    case "info": {
      const fabric = await openFabric();
      console.log(`endpoint-id : ${fabric.endpointId}`);
      console.log(`fabric-id   : ${await fabric.fabricIdHex()}`);
      await fabric.shutdown();
      break;
    }
    case "invite": {
      const fabric = await openFabric();
      const ttl = Number(opt("--ttl", String(10 * 60 * 1000)));
      const token = await fabric.invite(ttl, opt("--for") ?? null);
      console.log(token);
      await fabric.shutdown();
      break;
    }
    case "join": {
      const token = positionals[0];
      if (!token?.startsWith("dweb1.")) {
        throw new Error("join 需要一个 dweb1. 邀请令牌作为参数");
      }
      const fabric = await Fabric.joinWithToken(baseOpts, token);
      console.log(`joined fabric ${await fabric.fabricIdHex()}`);
      console.log(`  endpoint-id : ${fabric.endpointId}`);
      console.log(`  members     : ${(await fabric.members()).length}`);
      await fabric.shutdown();
      break;
    }
    case "members": {
      const fabric = await openFabric();
      const members = await fabric.members();
      console.log(`${members.length} member(s):`);
      for (const m of members) {
        const self = m.endpointId === fabric.endpointId ? " (self)" : "";
        const name = m.displayName ? ` ${m.displayName}` : "";
        console.log(`  ${m.endpointId}${name}${self}`);
      }
      await fabric.shutdown();
      break;
    }
    case "connect": {
      const fabric = await openFabric();
      await fabric.connect(positionals[0]);
      console.log(`connected ${shortId(positionals[0])} (${await fabric.linkStatus(positionals[0])})`);
      await fabric.shutdown();
      break;
    }
    case "send": {
      const fabric = await openFabric();
      const [to, ...rest] = positionals;
      await fabric.connect(to);
      await fabric.send(to, Buffer.from(rest.join(" "), "utf8"));
      console.log(`sent ${rest.length ? rest.join(" ").length : 0} bytes to ${shortId(to)}`);
      await fabric.shutdown();
      break;
    }
    case "name": {
      const fabric = await openFabric();
      await fabric.setDisplayName(positionals[0]);
      console.log(`display name set: ${args[1]}`);
      await fabric.shutdown();
      break;
    }
    case "revoke": {
      const fabric = await openFabric();
      await fabric.revoke(positionals[0]);
      console.log(`revoked ${shortId(positionals[0])}`);
      await fabric.shutdown();
      break;
    }
    case "chat": {
      const fabric = await openFabric();
      fabric.on((ev) => {
        if (ev.type === "message") {
          console.log(`[${shortId(ev.from)}] ${ev.data.toString("utf8")}`);
        } else if (ev.type === "peer-connected") {
          console.log(`-- ${shortId(ev.endpointId)} connected (${ev.endpointId})`);
        } else if (ev.type === "peer-disconnected") {
          console.log(`-- ${shortId(ev.endpointId)} disconnected`);
        }
      });
      console.log(`chat ready as ${fabric.endpointId} (${dataDir})`);
      const members = await fabric.members();
      for (const m of members) {
        if (m.endpointId !== fabric.endpointId) {
          fabric.connect(m.endpointId).catch((e) => console.error(`connect ${shortId(m.endpointId)}:`, e.message));
        }
      }
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (line) => {
        const text = line.trim();
        if (!text) return;
        (async () => {
          const peers = (await fabric.members()).filter((m) => m.endpointId !== fabric.endpointId);
          await Promise.all(
            peers.map((p) =>
              fabric
                .connect(p.endpointId)
                .then(() => fabric.send(p.endpointId, Buffer.from(text, "utf8")))
                .catch((e) => console.error(`send to ${shortId(p.endpointId)}:`, e.message)),
            ),
          );
          console.log(`[me] ${text}`);
        })();
      });
      // chat 模式常驻直至 Ctrl+C
      await new Promise(() => {});
      break;
    }
    case "help":
    default:
      console.log(`dweb-example — dweb 组网示例

  init                      创建新 fabric（本机成为 root）
  id / info                 打印身份
  invite [--ttl ms] [--for id]  签发邀请令牌（root）
  join <token>              兑换令牌加入
  members                   列出成员
  connect <endpointId>      连接成员
  send <endpointId> <text>  发送文本
  chat                      交互聊天（自动连接全部成员）
  name <display>            设置显示名
  revoke <endpointId>       撤销成员（root）

环境：--data <dir> / DWEB_DATA 数据目录（默认 ~/.dweb-example）
      DWEB_RELAY=disabled|custom|n0，DWEB_RELAY_URLS=<url,...>`);
      break;
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
