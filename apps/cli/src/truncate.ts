// Shared by memory/store.ts (error messages), memory/commands.ts (/memory pending's summary
// line) and memory/injectionScan.ts (the matched-excerpt a rejection reason shows) — three
// independent call sites for the same "cap a string, mark that it was cut" shape, at the flat
// top-level-utility location matching atomicWriteFile.ts's own precedent for exactly this.
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
