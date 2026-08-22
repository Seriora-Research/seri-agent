// Re-export shim: handlers.ts moved to state/handlers.ts (zero content change) as part of the
// OpenTUI migration's module reorganization. Kept here because cli.ts's own top-level import still
// resolves through this path (an unrelated cleanup, out of this dispatch's own file scope) and
// handlers.test.ts asserts against it directly (Phase 3's own job to rewrite).
export * from "./state/handlers";
