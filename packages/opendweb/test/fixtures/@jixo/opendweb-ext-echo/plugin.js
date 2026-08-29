// 测试夹具插件（CLI 面）：合法清单 + 可运行命令
export default {
  name: "echo",
  apiVersion: 1,
  commands: [
    {
      name: "hello",
      description: "greet by name",
      args: {
        type: "object",
        properties: { name: { type: "string" }, loud: { type: "boolean" }, times: { type: "number" } },
        required: ["name"],
      },
    },
    {
      name: "fail",
      description: "always fails (wrapper error normalization)",
      args: { type: "object", properties: {}, required: [] },
    },
  ],
  async run({ command, args, log }) {
    if (command === "hello") {
      const times = args.times ?? 1;
      for (let i = 0; i < times; i++) {
        log(`hello ${args.name}${args.loud ? "!" : ""}`);
      }
      return { exit: 0 };
    }
    if (command === "fail") {
      throw new Error("boom from echo plugin");
    }
    return { exit: 0 };
  },
};
