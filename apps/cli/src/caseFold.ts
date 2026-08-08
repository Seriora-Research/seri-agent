// NTFS and APFS are case-insensitive by default; ext4 (Linux) is not. Three independent callers
// each need to know whether the current filesystem folds case before comparing or hashing a name —
// extracted here per permissions/store.ts's own precedent for this exact check ("if a third caller
// appears, extract it then"): checkpoint.ts's checkpointStoreDir, permissions/store.ts's
// projectKey, and config/paths.ts's profile-name handling.
export function foldsCase(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}
