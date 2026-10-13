const encoder = new TextEncoder();
export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function equalHex(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a || '') || !/^[a-f0-9]{64}$/.test(b || '')) return false;
  let diff = 0; for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function sameSecret(a, b) { return Boolean(a && b) && equalHex(await hmacHex(a, 'reading-auth'), await hmacHex(b, 'reading-auth')); }
export async function issueToken(secret, claims, seconds = 3600) {
  if (!secret) throw new Error('Missing signing secret');
  const raw = JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + seconds });
  const encoded = btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
  return `${encoded}.${await hmacHex(secret, encoded)}`;
}
export async function verifyToken(secret, token, purpose) {
  try {
    if (!secret || typeof token !== 'string' || token.length > 2048) return null;
    const [encoded, signature, extra] = token.split('.');
    if (extra || !encoded || !equalHex(signature, await hmacHex(secret, encoded))) return null;
    const claims = JSON.parse(atob(encoded.replaceAll('-','+').replaceAll('_','/')));
    if (claims.purpose !== purpose || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now()/1000) || !/^[a-zA-Z0-9_-]{1,100}$/.test(claims.user_id || '')) return null;
    return claims;
  } catch { return null; }
}
export async function principalFor(request, env) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (bearer && await sameSecret(bearer, env.READER_TOKEN)) return {role:'reader', user_id:env.DEFAULT_USER_ID || 'reader'};
  const cookie = request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('reading_session='))?.slice(16);
  const claims = await verifyToken(env.SESSION_SECRET, bearer || cookie, 'session');
  return claims ? {role:'reader',user_id:claims.user_id} : null;
}
