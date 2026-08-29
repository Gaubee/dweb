// 测试夹具插件（src/ 布局）：入口在包根的子目录，证明 plugin add 的
// findPackageRoot 会向上查找 package.json 而非假定 dirname(entry) 即包根
export default {
  name: "srclayout",
  apiVersion: 1,
  commands: [
    {
      name: "ping",
      description: "reply pong",
      args: { type: "object", properties: {}, required: [] },
    },
  ],
  async run({ command, log }) {
    if (command === "ping") {
      log("pong");
      return { exit: 0 };
    }
    return { exit: 2 };
  },
};
