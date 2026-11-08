const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export type User = { id: string; name: string; email: string; role: string; createdAt: string };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields?: Record<string, string[]>,
    public code?: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: init.method ?? "GET",
      credentials: "include", // send the HttpOnly session cookie
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Please try again.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Something went wrong", res.status, data.fields, data.code, data);
  return data as T;
}
