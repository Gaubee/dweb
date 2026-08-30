// tsdown 构建配置（Owner 第三轮决策：cf 插件升级 TS + tsdown 编译）。
// 依赖分类语义（AGENTS 纠偏条目）：tsdown 只 bundle devDependencies 里的包；
// dependencies 里的包被视为 external（产物保留 import，由消费者解析）。
// 本包要打进单一产物的依赖（@clack/prompts）因此放在 devDependencies——
// 发布包零运行时依赖。验证动作见 package.json 的 pack:dry script。
import { defineConfig } from "tsdown";

export default defineConfig({
  // 双面入口：config 面（exports["."]）+ CLI 面（exports["./opendweb-plugin"）；
  // 其余模块同样作为入口——测试直接测 dist 产物（编译后行为），公共代码
  // 经共享 chunk 去重
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    tui: "src/tui.ts",
    prompts: "src/prompts.ts",
    wizard: "src/wizard.ts",
    "cf-api": "src/cf-api.ts",
  },
  format: "esm",
  dts: true,
  // 无 platform 特定语法；保持可读的产物便于宿主 containment 校验
  minify: false,
});
