// 测试夹具插件（config 面根导出）：npm 插件对象契约 {name, hooks}
export default {
  name: "echo",
  hooks: {
    async "server.preStart"(ctx) {
      return { server: { trustProxy: true }, bannerLines: [`echo preStart (options: ${JSON.stringify(ctx.options ?? {})})`] };
    },
    async "server.postReady"() {
      return { bannerLines: ["echo postReady"] };
    },
    async setup() {
      return { ok: true };
    },
  },
};
