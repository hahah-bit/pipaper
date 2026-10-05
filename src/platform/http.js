export async function requestJson(url, { body, headers, ...options } = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...headers },
    body: body == null ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, details: data });
  return data;
}
