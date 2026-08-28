// Argument parsing (design D8): `--opt value` and `--opt=value` are fully
// equivalent, boolean flags take no value, path-like values get `~` expanded,
// unknown options fail with exit code 2 and list the known options.
// Also hosts duration parsing for --ttl / --join-timeout (design D9/D11).

import { UsageError, CliError } from "./errors.mjs";

/**
 * @param {string} value
 * @param {string} homedir
 * @returns {string}
 */
export function expandTilde(value, homedir) {
  if (value === "~") return homedir;
  if (value.startsWith("~/")) return homedir + value.slice(1);
  return value;
}

/**
 * Parse a duration with optional ms|s|m|h|d suffix. Bare numbers are
 * milliseconds (0.1.0 compatibility). Syntax errors throw CliError; range
 * checking is the caller's job (bounds differ per option).
 * @param {string} raw
 * @param {string} label option name for error messages, e.g. "--ttl"
 * @returns {number} milliseconds
 */
export function parseDurationMs(raw, label) {
  const m = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)?$/.exec(String(raw).trim());
  if (!m) {
    throw new CliError(`error: invalid ${label} value: ${raw} (expected <number>[ms|s|m|h|d])`);
  }
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const ms = n * mult;
  // Overflow guard: huge suffix values (e.g. 999999999d) must report out of
  // range, never wrap around.
  if (!Number.isFinite(ms) || ms > Number.MAX_SAFE_INTEGER) {
    return Number.POSITIVE_INFINITY;
  }
  return ms;
}

/**
 * @param {number} ms
 * @param {number} minMs
 * @param {number} maxMs
 * @param {string} label
 * @param {string} rangeText
 */
export function assertDurationRange(ms, minMs, maxMs, label, rangeText) {
  if (!(ms >= minMs && ms <= maxMs)) {
    throw new CliError(`error: ${label} out of range (${rangeText})`);
  }
}

/**
 * Parse CLI tokens.
 * @param {string[]} argv tokens (without command)
 * @param {{ [name: string]: { type: "string" | "boolean" | "multi"; tilde?: boolean } }} spec
 * @param {{ homedir?: string }} [ctx]
 * @returns {{ options: { [name: string]: string | boolean | string[] }, positionals: string[] }}
 */
export function parseArgv(argv, spec, ctx = {}) {
  const homedir = ctx.homedir ?? "";
  /** @type {{ [name: string]: string | boolean | string[] }} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  const known = Object.keys(spec);

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).trim();
      const inlineValue = eq >= 0 ? tok.slice(eq + 1) : undefined;
      const decl = spec[name];
      if (!decl) {
        throw new UsageError(
          `error: unknown option --${name} (known: ${known.map((k) => "--" + k).join(", ")})`,
        );
      }
      if (decl.type === "boolean") {
        if (inlineValue !== undefined) {
          throw new UsageError(`error: option --${name} does not take a value`);
        }
        options[name] = true;
      } else {
        let value = inlineValue;
        if (value === undefined) {
          if (i + 1 >= argv.length) {
            throw new UsageError(`error: option --${name} requires a value`);
          }
          value = argv[++i];
        }
        if (decl.tilde) value = expandTilde(value, homedir);
        if (decl.type === "multi") {
          if (!Array.isArray(options[name])) options[name] = [];
          (/** @type {string[]} */ (options[name])).push(value);
        } else {
          options[name] = value;
        }
      }
    } else {
      positionals.push(tok);
    }
  }
  return { options, positionals };
}
