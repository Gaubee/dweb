// 静态配置文件单测：TOML/JSON 同 schema、静态错误（零执行）、发现顺序、
// flag > env > config > default 优先级（接入 resolveServerArgs 第三参）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverConfig, loadConfigFile, ConfigFileSchema } from "../src/config-file.mjs";
import { resolveServerArgs, validatePublicUrl } from "../bin/opendweb.mjs";
import { CliExit } from "../src/util.mjs";

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-cfg-"));
}

const TOML_SAMPLE = `
configVersion = 1

[server]
gatewayBind = "127.0.0.1:9000"
publicGatewayUrl = "https://gw.example.com"

[[plugins]]
name = "cf"

[[plugins]]
name = "frp"
[plugins.options]
tokenEnv = "TUNNEL_TOKEN"

[[plugins]]
file = "opendweb.plugins/backup.ts"
`;

const JSON_SAMPLE = {
  configVersion: 1,
  server: { gatewayBind: "127.0.0.1:9000", publicGatewayUrl: "https://gw.example.com" },
  plugins: [{ name: "cf" }, { name: "frp", options: { tokenEnv: "TUNNEL_TOKEN" } }, { file: "opendweb.plugins/backup.ts" }],
};

const urlCheck = (v) => validatePublicUrl(v, "url");

test("toml and json parse to the SAME shape (one schema, no drift)", async () => {
  const dir = await tmpDir();
  const tomlPath = path.join(dir, "opendweb.config.toml");
  const jsonPath = path.join(dir, "opendweb.config.json");
  await fsp.writeFile(tomlPath, TOML_SAMPLE, "utf8");
  await fsp.writeFile(jsonPath, JSON.stringify(JSON_SAMPLE, null, 2), "utf8");
  const toml = await loadConfigFile({ path: tomlPath, validateUrl: urlCheck });
  const json = await loadConfigFile({ path: jsonPath, validateUrl: urlCheck });
  assert.deepEqual(toml, json);
  assert.deepEqual(toml.plugins, JSON_SAMPLE.plugins);
});

test("static errors: bad toml / bad json / schema violation / bad url — no execution involved", async () => {
  const dir = await tmpDir();
  const badToml = path.join(dir, "a.toml");
  await fsp.writeFile(badToml, "configVersion = [unclosed", "utf8");
  await assert.rejects(() => loadConfigFile({ path: badToml }), /invalid TOML/);

  const badJson = path.join(dir, "b.json");
  await fsp.writeFile(badJson, "{nope", "utf8");
  await assert.rejects(() => loadConfigFile({ path: badJson }), /invalid JSON/);

  const badSchema = path.join(dir, "c.toml");
  await fsp.writeFile(badSchema, 'configVersion = 2\n', "utf8");
  await assert.rejects(() => loadConfigFile({ path: badSchema }), /configVersion/);

  const badUrl = path.join(dir, "d.toml");
  await fsp.writeFile(badUrl, 'configVersion = 1\n[server]\npublicGatewayUrl = "https://ex.com/path"\n', "utf8");
  await assert.rejects(() => loadConfigFile({ path: badUrl, validateUrl: urlCheck }), /publicGatewayUrl/);

  const unknownField = path.join(dir, "e.toml");
  await fsp.writeFile(unknownField, 'configVersion = 1\nhax = true\n', "utf8");
  await assert.rejects(() => loadConfigFile({ path: unknownField }), /hax/);
});

test("discoverConfig: toml beats json; --config explicit wins (and missing explicit errors)", async () => {
  const dir = await tmpDir();
  const exists = (p) => fs.existsSync(p);
  assert.equal(discoverConfig({ cwd: dir, existsSync: exists }), null);
  await fsp.writeFile(path.join(dir, "opendweb.config.json"), "{}", "utf8");
  assert.equal(discoverConfig({ cwd: dir, existsSync: exists }), path.join(dir, "opendweb.config.json"));
  await fsp.writeFile(path.join(dir, "opendweb.config.toml"), "configVersion = 1\n", "utf8");
  assert.equal(discoverConfig({ cwd: dir, existsSync: exists }), path.join(dir, "opendweb.config.toml"));
  assert.equal(
    discoverConfig({ cwd: dir, explicit: path.join(dir, "opendweb.config.json"), existsSync: exists }),
    path.join(dir, "opendweb.config.json"),
  );
  assert.throws(
    () => discoverConfig({ cwd: dir, explicit: path.join(dir, "nope.toml"), existsSync: exists }),
    CliExit,
  );
});

test("precedence: flag > env > config > default through resolveServerArgs", () => {
  const config = {
    gatewayBind: "127.0.0.1:9000",
    relayBind: "127.0.0.1:9100",
    relayEnabled: false,
    trustProxy: true,
    publicGatewayUrl: "https://cfg.example.com",
  };
  // config 单独生效
  const fromConfig = resolveServerArgs([], {}, config);
  assert.equal(fromConfig.gatewayBind, "127.0.0.1:9000");
  assert.equal(fromConfig.relayEnabled, false);
  assert.equal(fromConfig.trustProxy, true);
  assert.equal(fromConfig.publicGatewayUrl, "https://cfg.example.com");
  // env 压过 config；flag 压过 env
  const envWins = resolveServerArgs([], { DWEB_GATEWAY_BIND: "127.0.0.1:8000" }, config);
  assert.equal(envWins.gatewayBind, "127.0.0.1:8000");
  assert.equal(envWins.relayBind, "127.0.0.1:9100"); // env 未给 → config
  const flagWins = resolveServerArgs(["--gateway", "127.0.0.1:7000"], { DWEB_GATEWAY_BIND: "127.0.0.1:8000" }, config);
  assert.equal(flagWins.gatewayBind, "127.0.0.1:7000");
  // 无 config 无 env → default（回归锚点）
  const dflt = resolveServerArgs([], {});
  assert.equal(dflt.gatewayBind, "0.0.0.0:8787");
  assert.equal(dflt.relayEnabled, true);
});

test("schema rejects non-string plugin entries and empty names", () => {
  assert.equal(ConfigFileSchema.safeParse({ configVersion: 1, plugins: [42] }).success, false);
  assert.equal(ConfigFileSchema.safeParse({ configVersion: 1, plugins: [""] }).success, false);
  assert.equal(ConfigFileSchema.safeParse({ configVersion: 1, plugins: [{ name: "x", file: "y" }] }).success, false, "name 与 file 互斥");
});
