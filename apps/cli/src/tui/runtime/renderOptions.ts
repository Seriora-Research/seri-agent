import type { CliRenderer, CliRendererConfig } from "@opentui/core";
import { configValue, loadConfig, tuiBackgroundColor } from "../../config/config";

// OpenTUI defaults `exitOnCtrlC: true`, which destroys the renderer on the same press seri routes through signals.ts. OpenTUI defaults mouse reporting on, which steals terminal selection.
export const MAIN_TUI_RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  exitSignals: [],
  screenMode: "alternate-screen",
  useMouse: false,
};

// Default paper `#141413`. Non-hex `SERI_TUI_BACKGROUND` skips painting so terminal transparency still works.
// @opentui/core 0.5.6 ignores `CliRendererConfig.backgroundColor`; only `setBackgroundColor` paints.
export function applyTuiBackground(renderer: CliRenderer, configDir: string): void {
  const background = readTuiBackground(configDir);
  if (background !== undefined) renderer.setBackgroundColor(background);
}

function readTuiBackground(configDir: string): string | undefined {
  try {
    const raw = configValue("SERI_TUI_BACKGROUND", loadConfig(configDir));
    if (raw === undefined) return "#141413";
    return tuiBackgroundColor(raw);
  } catch {
    return undefined;
  }
}
