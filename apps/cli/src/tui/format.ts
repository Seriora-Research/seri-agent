// Re-export shim: format.ts moved to util/format.ts as part of the OpenTUI migration's module
// reorganization. Kept here so the untouched panels/ and useListWindow.ts call sites (a separate
// migration dispatch's job) don't need an import-path edit just to keep resolving.
export * from "./util/format";
