export const API_BASE = "/api";

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let message = response.statusText || "Request failed";
    try {
      const error = await response.json() as { error?: string };
      message = error.error ?? message;
    } catch {
      // Keep the status text when the response is not JSON.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null as T;
  }

  return await response.json() as T;
}
