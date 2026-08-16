// The ConfigRow fixture App.test.tsx and reducer.test.ts both build their /config test rows out
// of. A second copy of this would be the thing that drifts.
import {
  type ConfigRow,
  type ConfigRowBase,
  type ConfigRowKind,
  configKeyInfo,
} from "../../src/tui/commands";

type ConfigRowFields = Omit<ConfigRowBase, "key" | "label" | "description"> & ConfigRowKind;

// Derives label/description from configKeyInfo (tui/commands.ts) instead of hand-copying its
// production strings, so a copy change there doesn't leave a stale ConfigRow fixture asserting
// text CONFIG_KEY_INFO no longer says.
export function configRowFixture(key: string, fields: ConfigRowFields): ConfigRow {
  const { label, description } = configKeyInfo(key);
  return { key, label, description, ...fields };
}
