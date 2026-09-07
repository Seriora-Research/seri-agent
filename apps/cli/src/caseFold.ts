// NTFS and APFS fold case; ext4 does not.
export function foldsCase(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}
