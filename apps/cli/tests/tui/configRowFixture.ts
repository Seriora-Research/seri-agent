// The ConfigRow fixture App.test.tsx and reducer.test.ts both build their /config test rows out
// of. A second copy of this would be the thing that drifts.
import { type ConfigRow, configKeyInfo } from "../../src/tui/commands";

// A naked `T` in a conditional type distributes over T's union members before Omit strips
// "key"/"label"/"description" from each — plain `Omit<ConfigRow, ...>` would collapse the two
// branches first, via keyof's usual "keys common to every member" rule, and silently drop the
// boolean branch's own `on` field.
type ConfigRowFields<T> = T extends ConfigRow ? Omit<T, "key" | "label" | "description"> : never;

// Derives label/description from configKeyInfo (tui/commands.ts) instead of hand-copying its
// production strings, so a copy change there doesn't leave a stale ConfigRow fixture asserting
// text CONFIG_KEY_INFO no longer says.
export function configRowFixture(key: string, fields: ConfigRowFields<ConfigRow>): ConfigRow {
  const { label, description } = configKeyInfo(key);
  return { key, label, description, ...fields };
}
