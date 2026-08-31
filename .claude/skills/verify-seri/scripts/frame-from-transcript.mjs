// Renders a raw PTY transcript (from drive-tui.mjs) into a static frame: char grid, JSON cells, ANSI replay.
//
//   node frame-from-transcript.mjs <transcript-file> <out-prefix> [--cols N] [--rows N] [--at N]
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const pos = [];
const opt = { cols: 100, rows: 30, at: 0 };
for (let i = 0; i < args.length; i++) {
  const k = args[i].startsWith("--") ? args[i].slice(2) : "";
  if (k in opt) opt[k] = Number(args[++i]);
  else pos.push(args[i]);
}
const [input, prefix] = pos;
if (
  !input ||
  !prefix ||
  !Number.isInteger(opt.at) ||
  opt.at < 0 ||
  !(opt.cols > 0) ||
  !(opt.rows > 0)
) {
  console.error(
    "usage: frame-from-transcript.mjs <transcript-file> <out-prefix> [--cols N] [--rows N] [--at N]",
  );
  process.exit(2);
}
const { cols, rows } = opt;

const BASE = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
const hex = (r, g, b) =>
  "#" + [r, g, b].map((v) => (v & 255).toString(16).padStart(2, "0")).join("");
const xterm256 = (n) => {
  if (n < 16) return BASE[n];
  if (n > 231) return hex(8 + (n - 232) * 10, 8 + (n - 232) * 10, 8 + (n - 232) * 10);
  const c = n - 16;
  const q = [0, 95, 135, 175, 215, 255];
  return hex(q[(c / 36) | 0], q[((c / 6) | 0) % 6], q[c % 6]);
};

const attrs = { fg: null, bg: null, bold: false, dim: false, inverse: false };
const blank = () => ({ ch: " ", fg: null, bg: attrs.bg, bold: false, dim: false, inverse: false });
const fresh = () => Array.from({ length: rows }, () => Array.from({ length: cols }, blank));

let grid = fresh();
let row = 0;
let col = 0;
let wrap = false;

const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
const erase = (r0, c0, r1, c1) => {
  for (let r = r0; r <= r1; r++) {
    for (let c = r === r0 ? c0 : 0; c <= (r === r1 ? c1 : cols - 1); c++) grid[r][c] = blank();
  }
};
const lf = () => {
  if (row + 1 < rows) row++;
  else {
    grid.shift();
    grid.push(Array.from({ length: cols }, blank));
  }
};
// Deferred wrap, not eager: a glyph in the last column parks the cursor there. OpenTUI paints each
// row to the right edge and then sends ESC[K — wrapping eagerly would aim that erase at the row below.
const put = (ch) => {
  if (wrap) {
    col = 0;
    lf();
    wrap = false;
  }
  grid[row][col] = {
    ch,
    fg: attrs.fg,
    bg: attrs.bg,
    bold: attrs.bold,
    dim: attrs.dim,
    inverse: attrs.inverse,
  };
  if (col + 1 < cols) col++;
  else wrap = true;
};

const sgr = (ps) => {
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === 0)
      Object.assign(attrs, { fg: null, bg: null, bold: false, dim: false, inverse: false });
    else if (p === 1) attrs.bold = true;
    else if (p === 2) attrs.dim = true;
    else if (p === 7) attrs.inverse = true;
    else if (p === 22) Object.assign(attrs, { bold: false, dim: false });
    else if (p === 27) attrs.inverse = false;
    else if (p === 39) attrs.fg = null;
    else if (p === 49) attrs.bg = null;
    else if (p >= 30 && p <= 37) attrs.fg = BASE[p - 30];
    else if (p >= 90 && p <= 97) attrs.fg = BASE[p - 82];
    else if (p >= 40 && p <= 47) attrs.bg = BASE[p - 40];
    else if (p >= 100 && p <= 107) attrs.bg = BASE[p - 92];
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (ps[i + 1] === 2) {
        attrs[key] = hex(ps[i + 2], ps[i + 3], ps[i + 4]);
        i += 4;
      } else if (ps[i + 1] === 5) {
        attrs[key] = xterm256(ps[i + 2] & 255);
        i += 2;
      }
    }
  }
};

const s = readFileSync(input, "utf8");
let frames = 0;
let i = 0;
scan: while (i < s.length) {
  const cp = s.codePointAt(i);
  if (cp === 0x1b && s[i + 1] === "[") {
    const m = /^([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(s.slice(i + 2));
    if (!m) break;
    i += 2 + m[0].length;
    const [, p, inter, fin] = m;
    if (p[0] === "?") {
      const modes = p.slice(1).split(";");
      if (modes.includes("1049")) {
        // The frame we want is the last one painted while the TUI still owned the screen; everything
        // after the alt-screen exit is the shell repainting the primary buffer over it.
        if (fin === "l") break scan;
        if (fin === "h") {
          grid = fresh();
          row = 0;
          col = 0;
          wrap = false;
        }
      }
      if (fin === "h" && modes.includes("2026")) {
        frames++;
        if (opt.at && frames > opt.at) break scan;
      }
      continue;
    }
    if (inter || p[0] === ">" || p[0] === "<" || p[0] === "=") continue; // ESC[>4;1m is not SGR
    const ps = p.split(";").map(Number);
    const n = ps[0] || 1;
    if (fin === "H" || fin === "f") {
      row = clamp(n - 1, rows - 1);
      col = clamp((ps[1] || 1) - 1, cols - 1);
      wrap = false;
    } else if (fin === "A") (row = clamp(row - n, rows - 1)), (wrap = false);
    else if (fin === "B") (row = clamp(row + n, rows - 1)), (wrap = false);
    else if (fin === "C") (col = clamp(col + n, cols - 1)), (wrap = false);
    else if (fin === "D") (col = clamp(col - n, cols - 1)), (wrap = false);
    else if (fin === "J") {
      const mode = ps[0] || 0;
      if (mode === 0) erase(row, col, rows - 1, cols - 1);
      else if (mode === 1) erase(0, 0, row, col);
      else erase(0, 0, rows - 1, cols - 1);
    } else if (fin === "K") {
      const mode = ps[0] || 0;
      if (mode === 0) erase(row, col, row, cols - 1);
      else if (mode === 1) erase(row, 0, row, col);
      else erase(row, 0, row, cols - 1);
    } else if (fin === "X") erase(row, col, row, clamp(col + n - 1, cols - 1));
    else if (fin === "m") sgr(ps);
    continue;
  }
  if (cp === 0x1b && s[i + 1] === "]") {
    const bel = s.indexOf("\x07", i + 2);
    const st = s.indexOf("\x1b\\", i + 2);
    if (bel < 0 && st < 0) break;
    const end = st < 0 || (bel >= 0 && bel < st) ? bel : st;
    i = end + (end === bel ? 1 : 2);
    continue;
  }
  if (cp === 0x1b) {
    const m = /^[\x20-\x2f]*[\x30-\x7e]/.exec(s.slice(i + 1));
    i += 1 + (m ? m[0].length : 1);
    continue;
  }
  i += cp > 0xffff ? 2 : 1;
  if (cp === 0x0d) (col = 0), (wrap = false);
  else if (cp === 0x0a) lf(), (wrap = false);
  else if (cp === 0x08) (col = clamp(col - 1, cols - 1)), (wrap = false);
  else if (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f)) put(String.fromCodePoint(cp));
}

const parts = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)).join(";");
const key = (c) => `${c.fg}|${c.bg}|${c.bold}|${c.dim}|${c.inverse}`;
const seq = (c) => {
  const p = ["0"];
  if (c.bold) p.push("1");
  if (c.dim) p.push("2");
  if (c.inverse) p.push("7");
  if (c.fg) p.push(`38;2;${parts(c.fg)}`);
  if (c.bg) p.push(`48;2;${parts(c.bg)}`);
  return `\x1b[${p.join(";")}m`;
};
const plain = (c) => c.ch === " " && !c.fg && !c.bg && !c.bold && !c.dim && !c.inverse;

writeFileSync(
  `${prefix}.txt`,
  grid
    .map((r) =>
      r
        .map((c) => c.ch)
        .join("")
        .replace(/ +$/, ""),
    )
    .join("\n") + "\n",
);
writeFileSync(`${prefix}.json`, JSON.stringify({ cols, rows, cells: grid }));
writeFileSync(
  `${prefix}.ansi`,
  grid
    .map((r) => {
      let end = r.length;
      while (end > 0 && plain(r[end - 1])) end--;
      let out = "";
      let last = "";
      for (let c = 0; c < end; c++) {
        const k = key(r[c]);
        if (k !== last) (out += seq(r[c])), (last = k);
        out += r[c].ch;
      }
      return out + "\x1b[0m";
    })
    // No trailing newline: on a terminal exactly `rows` tall it would scroll the top line away.
    .join("\r\n"),
);

console.error(
  `frame: ${cols}x${rows}, ${grid.filter((r) => r.some((c) => c.ch !== " ")).length} non-blank rows`,
);
