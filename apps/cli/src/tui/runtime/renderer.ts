import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { messageOf } from "../../errors";
import { deliverSignal, onSignalCleanupLast } from "../../signals";
import { applyTuiBackground, MAIN_TUI_RENDERER_CONFIG } from "./renderOptions";

let instance: { renderer: CliRenderer; root: Root } | undefined;

// @opentui/react `createRoot(renderer).render()` starts a new reconciler and does not run the previous tree's effect cleanups.
export function unmountBeforeRender(rawRoot: Root): Root {
  return {
    render: (node) => {
      rawRoot.unmount();
      rawRoot.render(node);
    },
    unmount: () => rawRoot.unmount(),
  };
}

export async function getTuiRenderer(
  configDir: string,
): Promise<{ renderer: CliRenderer; root: Root }> {
  if (instance !== undefined) return instance;
  const renderer = await createCliRenderer(MAIN_TUI_RENDERER_CONFIG);
  applyTuiBackground(renderer, configDir);
  const root = unmountBeforeRender(createRoot(renderer));
  instance = { renderer, root };
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") deliverSignal("SIGINT");
  });
  process.on("uncaughtException", (err) => {
    destroyTuiRenderer();
    console.error(messageOf(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    destroyTuiRenderer();
    console.error(messageOf(err));
    process.exit(1);
  });
  onSignalCleanupLast(() => {
    instance?.renderer.destroy();
  });
  return instance;
}

export function destroyTuiRenderer(): void {
  if (instance === undefined) return;
  instance.renderer.destroy();
  instance = undefined;
}
