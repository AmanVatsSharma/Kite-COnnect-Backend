const rawBase = import.meta.env.VITE_API_BASE ?? '';

/** API origin without trailing slash; empty = same origin (Vite proxy or prod). */
export function getApiBase(): string {
  return String(rawBase).replace(/\/$/, '');
}

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  const b = getApiBase();
  return b ? `${b}${p}` : p;
}
