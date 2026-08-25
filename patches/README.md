# Vendored patches

## `@opentui%2Fcore@0.5.6.patch`

Threads the markdown renderable's own `fg` (the color the app passes via
`<markdown fg={theme.text}>`) into its table-rendering path. Without it, table
cell text ignores `fg` entirely and falls back to `TextTableRenderable`'s
hardcoded white default — see `docs/specs/031-tui-table-text-color/research.md`
for the full diagnosis (issue #165).

Two lines, both inside `@opentui/core`'s compiled `index.bun.js`:
`MarkdownRenderable#resolveTableRenderableOptions()` gains `fg: this._fg` in
its returned options object, and `MarkdownRenderable#createTextTableRenderable()`
passes that through as `fg: options.fg` into the `TextTableRenderable`
constructor call.

**Pinned to `@opentui/core@0.5.6` exactly** (see `apps/cli/package.json`) — the
patch targets compiled output, not source, so it is not expected to survive a
version bump unchanged. `bun install` fails loudly if the patch can't apply to
whatever version is installed; the 4 table-color regression tests in
`apps/cli/tests/tui/App.test.tsx` (search `TABLE_CELL_COLOR_CASES`) also fail
if a version bump silently drops the fix.

**Drop condition:** delete this patch (and its `patchedDependencies` entry in
the root `package.json`) once a `@opentui/core` release forwards `fg` into its
table-rendering path natively — check whether the upstream fix has landed
before bumping past `0.5.6`.

Filed upstream: [anomalyco/opentui#1432](https://github.com/anomalyco/opentui/issues/1432).
