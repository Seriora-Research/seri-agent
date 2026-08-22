// Re-export shim: theme.ts moved to theme/theme.ts as part of the OpenTUI migration's module
// reorganization. Kept here so the untouched panels/ call sites (a separate migration dispatch's
// job) don't need an import-path edit just to keep resolving.
export * from "./theme/theme";
