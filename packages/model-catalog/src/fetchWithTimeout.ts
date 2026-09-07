






















export async function fetchWithTimeout<T>(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}
