const KEY = "tagseed_token";
export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

export async function api(path, opts = {}) {
  const token = getToken();
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (r.status === 401) { setToken(null); window.location.hash = "#/login"; throw new Error("unauthorized"); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 429 && data.detail === "daily_limit") { window.location.hash = "#/limit"; throw new Error("daily_limit"); }
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "حصلت مشكلة، جرّب تاني");
  return data;
}
