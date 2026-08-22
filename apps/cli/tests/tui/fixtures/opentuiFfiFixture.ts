// Standalone entry point for opentuiFfiSmoke.test.ts: `bun build --compile` needs a real file on
// disk (module resolution walks up from its own location, not a temp dir outside the repo tree),
// and this is the smallest thing that actually loads the native module rather than pulling in the
// whole TUI's own pure-JS surface along with it. `createTestRenderer` is OpenTUI's own headless
// test harness (no real TTY required), and
// `getNativeStats()` reads a struct back from the native side via FFI, so a failure here is
// oven-sh/bun#30717's exact symptom (native module fails to dlopen inside a compiled binary), not
// a plain JS import error.
import { createTestRenderer } from "@opentui/core/testing";

const { renderer, getNativeStats } = await createTestRenderer({ width: 10, height: 10 });
const stats = getNativeStats();
renderer.destroy();
console.log(`OPENTUI_FFI_OK nativeFrameCount=${stats.nativeFrameCount}`);
