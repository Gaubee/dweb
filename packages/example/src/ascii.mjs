// ASCII discipline (design D10): every user-facing CLI string must have code
// points < 128. Dynamic values (paths, URLs, error reasons, env values) are
// escaped per UTF-8 byte with lowercase hex \xNN -- control characters
// (<0x20 and 0x7F, including newlines) are escaped the same way so an error is
// always exactly one line.

/**
 * Escape a dynamic value for ASCII-only output.
 * Printable ASCII 0x20..0x7e passes through; every other UTF-8 byte becomes
 * `\xNN` (lowercase hex). Newlines therefore never split an error line.
 * @param {unknown} value
 * @returns {string}
 */
export function asciiEscape(value) {
  const s = value === undefined || value === null ? String(value) : String(value);
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) {
      out += String.fromCharCode(b);
    } else {
      out += "\\x" + b.toString(16).padStart(2, "0");
    }
  }
  return out;
}

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isAscii(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}
