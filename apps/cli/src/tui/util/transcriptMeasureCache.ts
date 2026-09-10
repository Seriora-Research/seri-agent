import type { TranscriptEntry } from "./format";

export type TranscriptMeasureCache = {
  handlerFor(entry: TranscriptEntry): (this: { height: number }) => void;
  sync(transcript: readonly TranscriptEntry[]): Array<number | undefined>;
  reset(): void;
  size(): number;
};

export function createTranscriptMeasureCache(onInvalidate: () => void): TranscriptMeasureCache {
  // Slice keeps the same entry objects; index is only a paint coordinate, so a
  // front-drop at constant length would reuse stale heights if we keyed by index.
  const rows = new Map<
    TranscriptEntry,
    { height?: number; handler: (this: { height: number }) => void }
  >();

  function handlerFor(entry: TranscriptEntry): (this: { height: number }) => void {
    const existing = rows.get(entry);
    if (existing !== undefined) return existing.handler;
    function onRowSizeChange(this: { height: number }) {
      if (this.height <= 0) return;
      const slot = rows.get(entry) ?? { handler: onRowSizeChange };
      if (slot.height === this.height) return;
      slot.height = this.height;
      rows.set(entry, slot);
      onInvalidate();
    }
    rows.set(entry, { handler: onRowSizeChange });
    return onRowSizeChange;
  }

  function sync(transcript: readonly TranscriptEntry[]): Array<number | undefined> {
    const live = new Set(transcript);
    for (const key of rows.keys()) {
      if (!live.has(key)) rows.delete(key);
    }
    return transcript.map((entry) => rows.get(entry)?.height);
  }

  function reset(): void {
    rows.clear();
  }

  function size(): number {
    return rows.size;
  }

  return { handlerFor, sync, reset, size };
}
