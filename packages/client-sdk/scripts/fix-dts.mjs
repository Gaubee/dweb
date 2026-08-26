// napi 生成的 d.ts 后处理：修正事件回调签名并导出事件类型
import * as fs from "node:fs";

const p = new URL("../index.d.ts", import.meta.url).pathname;
let s = fs.readFileSync(p, "utf8");
s = s.replaceAll("=> any", "=> void");
// on 的原生签名是 error-first 字符串；index.js 包装后是类型化事件对象
s = s.replace(/on\(callback: [^\n]*\): void/, "on(callback: (event: FabricEventJs) => void): void");
if (!s.includes("FabricEventJs")) {
  s = `export interface FabricEventJs {
  type: 'peer-connected' | 'peer-disconnected' | 'roster-updated' | 'message' | 'path-changed'
  endpointId?: string
  from?: string
  data?: Buffer
  status?: 'direct' | 'relay' | 'unknown'
}

` + s;
}
fs.writeFileSync(p, s);
console.log("index.d.ts fixed");
