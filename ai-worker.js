// Cloudflare Worker: прокси между приложением и Anthropic API.
// Ключ хранится в секрете ANTHROPIC_API_KEY, а не в коде и не в репозитории.
const MODEL = 'claude-haiku-5-5';
const ORIGIN = 'https://ne1iks.github.io';
const PROJECT = 'navi-chat-ced31';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const SYSTEM = 'Ты дружелюбный помощник в мессенджере «Круг». Отвечай по-русски, кратко и по делу, если не попросят иначе.';

const CORS = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const dec = s => JSON.parse(new TextDecoder().decode(b64(s)));

// Проверка Firebase ID token: подпись Google и поля токена.
async function verify(token) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('bad token');
  const head = dec(h), pay = dec(p), now = Date.now() / 1000;
  if (head.alg !== 'RS256') throw new Error('alg');
  if (pay.aud !== PROJECT || pay.iss !== 'https://securetoken.google.com/' + PROJECT) throw new Error('claims');
  if (!pay.sub || pay.exp < now || pay.iat > now + 60) throw new Error('time');
  const jwks = await (await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
  const jwk = jwks.keys.find(k => k.kid === head.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw new Error('signature');
  return pay.sub;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
    if (req.headers.get('Origin') !== ORIGIN) return json({ error: 'Доступ запрещён' }, 403);

    try { await verify((req.headers.get('Authorization') || '').replace(/^Bearer /, '')); }
    catch { return json({ error: 'Войдите в аккаунт' }, 401); }

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Неверный запрос' }, 400); }
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'Пустой вопрос' }, 400);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: 'Сервис ИИ временно недоступен' }, 502);
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return json({ text: text || 'Пустой ответ' });
  },
};
