/** Parse JSON without hiding a backend/proxy error behind a JSON SyntaxError. */
export async function readApiJson(response: Response, action: string) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${action} (HTTP ${response.status}): ${text.trim().slice(0, 200) || "Phản hồi rỗng/không phải JSON"}`);
  }
  if (!response.ok) {
    const detail = data?.detail ?? data?.error ?? response.statusText;
    throw new Error(`${action} (HTTP ${response.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return data;
}
