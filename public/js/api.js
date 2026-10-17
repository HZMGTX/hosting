// Fetch wrapper: JSON in/out, CSRF header, friendly errors, 401 → sign-in screen.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-Omnihost': '1' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, 'Cannot reach the OmniHost server. Is it running?'); }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized();
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: (url, o) => request('GET', url, undefined, o),
  post: (url, body, o) => request('POST', url, body ?? {}, o),
  put: (url, body, o) => request('PUT', url, body ?? {}, o),
  patch: (url, body, o) => request('PATCH', url, body ?? {}, o),
  del: (url, o) => request('DELETE', url, undefined, o)
};

export const svcUrl = (id, rest = '') => `/api/services/${encodeURIComponent(id)}${rest}`;
