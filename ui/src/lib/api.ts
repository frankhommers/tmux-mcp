/**
 * The token arrives once in the query string and then lives in sessionStorage,
 * so refreshing or following a deep link keeps working without it in the URL.
 * The app shell is served without a token; only these calls need it.
 */
const TOKEN_KEY = 'tmux-mcp-token';

function readToken(): string {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('t');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    params.delete('t');
    history.replaceState({}, '', location.pathname + (params.toString() ? `?${params}` : ''));
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export const token = readToken();

export class ApiError extends Error {}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface PaneRequest {
  id: string;
  reason: string;
  kind: 'pane' | 'window';
  createdAt: number;
  ageSeconds: number;
}

export interface Target {
  id: string;
  label: string;
}

export function listRequests() {
  return api<{ requests: PaneRequest[] }>('/api/requests');
}

export function listTargets(requestId: string) {
  return api<{ targets: Target[] }>(`/api/requests/${requestId}/targets`);
}

export function grant(requestId: string, target: string) {
  return api<{ ok: true }>(`/api/requests/${requestId}/grant`, {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
}

export function deny(requestId: string, reason: string) {
  return api<{ ok: true }>(`/api/requests/${requestId}/deny`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/**
 * A tmux label is "%3  session:window.0  zsh  "title"", built by the server.
 * Splitting it here lets the row show the id and command prominently and the
 * location and title quietly, instead of one long monospace string.
 */
export function parseLabel(label: string): {
  id: string;
  location: string;
  command: string;
  title: string;
} {
  const parts = label.split(/\s{2,}/);
  return {
    id: parts[0] ?? label,
    location: parts[1] ?? '',
    command: parts[2] ?? '',
    title: (parts[3] ?? '').replace(/^"|"$/g, ''),
  };
}
