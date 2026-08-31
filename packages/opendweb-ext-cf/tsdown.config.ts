// tsdown 构建配置（1.0.0 重写）。依赖分类语义（AGENTS 纠偏条目）：tsdown 只
// bundle devDependencies 里的包；dependencies 视为 external。本包要打进单一
// 产物的依赖（@clack/prompts、cloudflare[tree-shakable]、cloudflared）全部在
// devDependencies——发布包零运行时依赖。验证动作见 package.json 的 pack:dry。
import { defineConfig } from "tsdown";

export default defineConfig({
  // 双面入口：config 面（exports["."]）+ CLI 面（exports["./opendweb-plugin"）；
  // 其余模块同样作为入口——测试直接测 dist 产物，公共代码经共享 chunk 去重
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    tui: "src/tui.ts",
    prompts: "src/prompts.ts",
    "cf-client": "src/cf-client.ts",
    "route-model": "src/route-model.ts",
    provision: "src/provision.ts",
    auth: "src/auth.ts",
    connector: "src/connector.ts",
    "cf-api": "src/cf-api.ts",
  },
  format: "esm",
  dts: true,
  // 无 platform 特定语法；保持可读的产物便于宿主 containment 校验
  minify: false,
});
