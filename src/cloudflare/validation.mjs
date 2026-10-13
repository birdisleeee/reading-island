export class ReadingError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireValue(condition, code = 'invalid_input', status = 400) {
  if (!condition) throw new ReadingError(status, code);
}
export function identity(value) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value), 'invalid_identity');
  return value;
}
export function text(value, max, optional = false) {
  if (optional && value == null) return '';
  requireValue(typeof value === 'string' && value.isWellFormed() && value.length <= max && (optional || value.trim().length > 0));
  return value;
}
export const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(n => n.toString(16).padStart(2, '0')).join('');
export async function readBody(request, max) {
  const reader = request.body?.getReader();
  requireValue(reader, 'body_required');
  const parts = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new ReadingError(413, 'body_too_large'); }
    parts.push(value);
  }
  const result = new Uint8Array(size); let at = 0;
  for (const part of parts) { result.set(part, at); at += part.byteLength; }
  return result;
}
export async function readJson(request) {
  requireValue(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'json_required', 415);
  const bytes = await readBody(request, 64 * 1024);
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireValue(result && typeof result === 'object' && !Array.isArray(result));
    return result;
  } catch { throw new ReadingError(400, 'invalid_json'); }
}
