export async function rpc<T>(
  url: string,
  method: string,
  params: unknown[] = [],
  token?: string,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.jsonrpc !== '2.0' || body.id !== 1 || !('result' in body) || body.error)
    throw Error(
      `${method}: ${String(body.error?.message ?? 'invalid response').replaceAll(token || '\0', '[REDACTED]')}`,
    );
  return body.result as T;
}
