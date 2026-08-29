// marketplace 单测：默认候选集、glob 校验、add/remove 事务、候选展开。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_GLOBS,
  validateGlob,
  parseGlobInput,
  loadMarketplace,
  saveMarketplace,
  marketplaceAdd,
  marketplaceRemove,
  candidatesFor,
} from "../src/marketplace.mjs";
import { CliExit } from "../src/util.mjs";

async function tmpFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-mp-"));
  return path.join(dir, "marketplace.json");
}

test("default globs: scoped official first, unscoped community second (Owner decision)", () => {
  assert.deepEqual(DEFAULT_GLOBS, ["npm:@jixo/opendweb-ext-*", "npm:opendweb-*"]);
});

test("validateGlob: npm: only, exactly one *", () => {
  assert.equal(validateGlob("npm:opendweb-*"), null);
  assert.equal(validateGlob("npm:@x/y-*"), null);
  assert.match(String(validateGlob("github:foo/*")), /only npm:/);
  assert.match(String(validateGlob("npm:opendweb")), /must contain \*/);
  assert.match(String(validateGlob("npm:opendweb-*-*")), /exactly one \*/);
  assert.match(String(validateGlob("")), /non-empty/);
});

test("parseGlobInput: comma/space separated, hard error on empty or invalid", () => {
  assert.deepEqual(parseGlobInput("npm:a-*, npm:b-*  npm:c-*"), ["npm:a-*", "npm:b-*", "npm:c-*"]);
  assert.throws(() => parseGlobInput("   "), CliExit);
  assert.throws(() => parseGlobInput("npm:ok, https://evil/*"), CliExit);
});

test("loadMarketplace: missing file -> defaults; broken JSON -> hard error", async () => {
  const p = await tmpFile();
  const def = await loadMarketplace({ fs: fsp, path: p });
  assert.equal(def.source, "default");
  assert.deepEqual(def.globs, DEFAULT_GLOBS);

  await fsp.writeFile(p, "{ not json", "utf8");
  await assert.rejects(() => loadMarketplace({ fs: fsp, path: p }), CliExit);
});

test("marketplace add/remove roundtrip: dedupe, order preserved, unknown remove rejected", async () => {
  const p = await tmpFile();
  const first = await marketplaceAdd({ fs: fsp, path: p, input: "npm:mine-*" });
  assert.deepEqual(first.added, ["npm:mine-*"]);
  assert.deepEqual(first.globs, [...DEFAULT_GLOBS, "npm:mine-*"]);

  const again = await marketplaceAdd({ fs: fsp, path: p, input: "npm:mine-*" });
  assert.deepEqual(again.added, []);

  const after = await marketplaceRemove({ fs: fsp, path: p, input: "npm:mine-*" });
  assert.deepEqual(after.globs, DEFAULT_GLOBS);

  await assert.rejects(() => marketplaceRemove({ fs: fsp, path: p, input: "npm:ghost-*" }), CliExit);
});

test("candidatesFor: declaration order, * substitution, dedupe", () => {
  assert.deepEqual(candidatesFor(DEFAULT_GLOBS, "cf"), [
    "@jixo/opendweb-ext-cf",
    "opendweb-cf",
  ]);
  assert.deepEqual(candidatesFor(["npm:a-*", "npm:a-*"], "x"), ["a-x"]);
});
