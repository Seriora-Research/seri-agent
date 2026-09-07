#!/usr/bin/env node
// Asserts TUI chrome tokens against a captured frame.json (scripts/frame-from-transcript.mjs).
// A mock screenshot and a real session never share text, so an image diff cannot settle parity;
// these are the attributes that can be compared.
//
// Usage: node check-parity.mjs <frame.json>

import { readFileSync } from "node:fs";

const GROUND = "#141413";
const BAND = "#3e3e3a";
const BORDER = "#e8e4d8";
const MUTED = "#8f8d85";
const TEXT = "#e8e4d8";

const BORDER_CHARS = new Set(["┌", "┐", "└", "┘", "─", "│", "├", "┤", "┬", "┴", "┼"]);

const frame = JSON.parse(readFileSync(process.argv[2], "utf8"));
const grid = frame.cells;
const norm = (c) => (c === undefined || c === null ? "" : String(c).toLowerCase());
const rowText = (row) =>
  row
    .map((c) => c.ch ?? " ")
    .join("")
    .replace(/\s+$/, "");
const firstCol = (row) => row.findIndex((c) => (c.ch ?? " ").trim() !== "");

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// Measured and printed, never counted. A known gap that incremented the failure count would make
// the exit status permanently 1, which costs the script its whole use as a gate.
const notes = [];
const note = (name, met, detail) => notes.push({ name, met, detail });

const all = grid.flat();

const grounds = new Map();
for (const c of all) grounds.set(norm(c.bg), (grounds.get(norm(c.bg)) ?? 0) + 1);
const topGround = [...grounds.entries()].sort((a, b) => b[1] - a[1])[0];
check(
  "ground is #141413",
  topGround[0] === GROUND,
  `dominant bg ${topGround[0]} (${topGround[1]} cells)`,
);

// A cell is a border only when a box rule runs through it. TREE_BRANCH and TREE_MID are
// box-drawing characters used as muted text glyphs, and counting those as border cells reported
// the transcript's own tree lines as an off-target frame.
const isBorder = (row, i) =>
  BORDER_CHARS.has(row[i].ch) &&
  (BORDER_CHARS.has(row[i + 1]?.ch ?? "") || BORDER_CHARS.has(row[i - 1]?.ch ?? ""));
const borders = grid.flatMap((row) => row.filter((_, i) => isBorder(row, i)));
const badBorders = borders.filter((c) => norm(c.fg) !== BORDER);
check(
  "every border glyph is #e8e4d8",
  borders.length > 0 && badBorders.length === 0,
  `${borders.length} border cells, ${badBorders.length} off-target (${[...new Set(badBorders.map((c) => norm(c.fg)))].join(",") || "none"})`,
);

const strayGray = all.filter((c) => norm(c.fg) === "#808080");
check("no #808080 left anywhere", strayGray.length === 0, `${strayGray.length} cells`);

const muted = all.filter((c) => norm(c.fg) === MUTED && (c.ch ?? " ").trim() !== "");
check("muted text is #8F8D85", muted.length > 0, `${muted.length} cells`);

const prose = all.filter((c) => norm(c.fg) === TEXT && (c.ch ?? " ").trim() !== "");
check("prose text is #e8e4d8", prose.length > 0, `${prose.length} cells`);

const bandRows = grid.filter(
  (row) => row.filter((c) => norm(c.bg) === BAND).length > frame.cols / 2,
);
check("a full-width user band exists", bandRows.length > 0, `${bandRows.length} rows`);
for (const [i, row] of bandRows.entries()) {
  check(`band row ${i} text starts at column 1`, firstCol(row) === 1, `starts at ${firstCol(row)}`);
}

// The mock is a browser render of the app alone, so it cannot say whether the app carries an outer
// margin from the terminal edge. Every column claim below it CAN support is relative: the call
// line sits at the transcript's own left edge, and the result line two columns in from there.
const callRows = grid.filter((row) => /^→ \w+/.test(rowText(row).trimStart()));
check("a → tool call line exists", callRows.length > 0, `${callRows.length} rows`);
const inset = callRows.length > 0 ? Math.min(...callRows.map(firstCol)) : 0;
for (const [i, row] of callRows.entries()) {
  check(
    `call row ${i} sits at the transcript edge`,
    firstCol(row) === inset,
    `col ${firstCol(row)} against edge ${inset}`,
  );
  const next = grid[grid.indexOf(row) + 1];
  const col = next === undefined ? -1 : firstCol(next);
  check(
    `call row ${i} result is indented 2`,
    col === inset + 2,
    `result at col ${col}, want ${inset + 2}`,
  );
}

// The one measured attribute of the mock that is not met. The mock draws the input box's own rule
// in the same column as the transcript's text; the app insets the transcript one column past the
// box. Closing it means an inset on the app root, which narrows every panel by two columns against
// fixed table widths — the cost docs/specs/045-tui-spacing-and-surface/spec.md weighed and
// declined, and the tests that would catch the overflow are skipIf(win32).
// Only meaningful once a call row has fixed the transcript's edge; without one, `inset` is a
// default and this would report a pass nothing established.
if (callRows.length > 0) {
  // Scanned per row rather than read off row[0]: a box that is itself inset would leave row[0]
  // blank, and reporting "col -1" for it would contradict the very thing being measured.
  const boxCols = grid
    .map((row) => row.findIndex((c) => c.ch === "┌" || c.ch === "│"))
    .filter((i) => i >= 0);
  const boxCol = boxCols.length > 0 ? Math.min(...boxCols) : -1;
  note(
    "box rule shares the transcript's text column",
    boxCol === inset,
    `box at col ${boxCol}, transcript text at col ${inset}`,
  );
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name} - ${r.detail}`);
}
for (const n of notes) {
  console.log(`GAP${n.met ? " (closed)" : "        "}  ${n.name} - ${n.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
