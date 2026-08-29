#!/usr/bin/env node
// definePlugin 协议夹具：声明/回调模式 + 普通 import 无副作用
import { definePlugin } from "../src/index.js";

export default definePlugin({
  name: "helper-echo",
  hooks: {
    async "server.postReady"(ctx) {
      return { bannerLines: [`helper-echo ready (options: ${JSON.stringify(ctx.options ?? {})})`] };
    },
    async setup(ctx) {
      if (ctx.options?.fail) throw new Error("helper setup boom");
      return { via: "definePlugin" };
    },
  },
});
