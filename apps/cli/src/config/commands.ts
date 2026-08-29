// Values are provider API keys — show just enough to identify which key is stored without
// printing it in full, since /config and /setup output tends to end up in screenshots and issues.
export function maskValue(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
