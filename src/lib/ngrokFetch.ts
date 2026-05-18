/** Extra headers when calling a service through ngrok free tier from a server (Railway, etc.). */
export function withNgrokHeaders(
  url: string,
  headers: Record<string, string> = {}
): Record<string, string> {
  if (/ngrok-free\.(dev|app)/i.test(url)) {
    return { ...headers, "ngrok-skip-browser-warning": "69420" };
  }
  return headers;
}
