// Re-export shim: commands.ts moved to state/commands.ts (zero content change) as part of the
// OpenTUI migration's module reorganization. Kept here so the untouched panels/ call sites (a
// separate migration dispatch's job) don't need an import-path edit just to keep resolving.
export * from "./state/commands";
