export function maskValue(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
