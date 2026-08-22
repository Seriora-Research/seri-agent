// Re-export shim: handlers.ts moved to state/handlers.ts (zero content change) as part of the
// OpenTUI migration's module reorganization. Kept here so the untouched welcomeSplash.ts/
// guidedSetup.ts call sites (a separate migration dispatch's job) don't need an import-path edit
// just to keep resolving.
export * from "./state/handlers";
