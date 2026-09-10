import type { TranscriptEntry } from "./format";

export const MAX_LIVE_TRANSCRIPT_ROWS = 4096;

/**
 * Idempotent. Same array reference when `entries.length <= max`.
 * Otherwise a new array of the last `max` entries, same object identities.
 */
export function capLiveTranscript(
  entries: readonly TranscriptEntry[],
  max: number = MAX_LIVE_TRANSCRIPT_ROWS,
): TranscriptEntry[] {
  if (entries.length <= max) return entries as TranscriptEntry[];
  return entries.slice(entries.length - max);
}
