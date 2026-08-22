// Re-export shim: components.tsx split into ui/ErrorLine.tsx, ui/WarningBox.tsx,
// ui/ConfirmPrompt.tsx, ui/ListRow.tsx (now built on @opentui/react, not ink) as part of the
// OpenTUI migration's module reorganization. Kept here so the untouched panels/ call sites (a
// separate migration dispatch's job, still built on ink) keep resolving without an import-path
// edit — those callers are runtime-broken until that dispatch ports them, since these four
// components no longer render ink's own host elements.
export { ErrorLine } from "./ui/ErrorLine";
export { WarningBox } from "./ui/WarningBox";
export { ConfirmPrompt } from "./ui/ConfirmPrompt";
export { ListRow } from "./ui/ListRow";
