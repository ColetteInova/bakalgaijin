const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

export function api(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}
