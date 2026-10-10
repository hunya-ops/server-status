export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    signal: options?.signal || AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json", ...options?.headers },
    cache: "no-store",
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new ApiError(response.status, body.error || "请求失败");
  return body;
}
