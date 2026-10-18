const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws'), Database = require('better-sqlite3');
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'data.db')); db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, email TEXT UNIQUE, salt TEXT, hash TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS friends(a INTEGER, b INTEGER, status TEXT, PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, f INTEGER, t INTEGER, text TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS mf ON messages(f); CREATE INDEX IF NOT EXISTS mt ON messages(t);`);

const sf = path.join(__dirname, '.secret'); let SECRET;
try { SECRET = fs.readFileSync(sf); } catch (e) { SECRET = crypto.randomBytes(32); fs.writeFileSync(sf, SECRET, { mode: 0o600 }); }
const mac = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('hex');
const sign = (id) => { const p = id + '.' + (Date.now() + 30 * 864e5); return p + '.' + mac(p); };
const verify = (t) => {
  const [id, exp, sig] = String(t || '').split('.'); if (!sig) return 0;
  const ok = mac(id + '.' + exp);
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok)) || Date.now() > +exp) return 0;
  return +id;
};
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const UN = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const hits = new Map();
const limited = (ip) => { const n = Date.now(), a = (hits.get(ip) || []).filter(x => n - x < 60000); a.push(n); hits.set(ip, a); return a.length > 10; };

const socks = new Map();
const push = (id, o) => (socks.get(id) || []).forEach(w => w.readyState === 1 && w.send(JSON.stringify(o)));
const out = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 20000) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(new Error('json')); } });
});

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const h = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<script>', '<script>window.USE_SERVER=true;');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); return res.end(h);
  }
  if (!p.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  try {
    const b = req.method === 'GET' || req.method === 'DELETE' ? {} : await body(req), ip = req.socket.remoteAddress;
    if (p === '/api/register' && req.method === 'POST') {
      if (limited(ip)) return out(res, 429, { error: 'Слишком много попыток, подождите минуту' });
      const email = String(b.email || '').trim().toLowerCase(), u = String(b.username || '').trim(), pw = String(b.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) return out(res, 400, { error: 'Некорректная почта' });
      if (!UN.test(u)) return out(res, 400, { error: 'Некорректный юзернейм' });
      if (pw.length < 8 || pw.length > 200) return out(res, 400, { error: 'Пароль — от 8 символов' });
      const salt = crypto.randomBytes(16).toString('hex');
      try { const r = db.prepare('INSERT INTO users(username,email,salt,hash,created) VALUES(?,?,?,?,?)').run(u, email, salt, hashPw(pw, salt), Date.now()); return out(res, 200, { token: sign(r.lastInsertRowid) }); }
      catch (e) { return out(res, 409, { error: 'Почта или юзернейм уже заняты' }); }
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (limited(ip)) return out(res, 429, { error: 'Слишком много попыток, подождите минуту' });
      const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(b.email || '').trim().toLowerCase());
      if (!u || hashPw(String(b.password || ''), u.salt) !== u.hash) return out(res, 401, { error: 'Неверная почта или пароль' });
      return out(res, 200, { token: sign(u.id) });
    }
    const me = verify((req.headers.authorization || '').replace('Bearer ', ''));
    if (!me) return out(res, 401, { error: 'Нужно войти' });
    if (p === '/api/sync') {
      const u = db.prepare('SELECT id,username FROM users WHERE id=?').get(me); if (!u) return out(res, 401, { error: 'Нужно войти' });
      const fr = db.prepare('SELECT f.b, f.status, u.id uid, u.username FROM friends f JOIN users u ON u.id = (CASE WHEN f.a=? THEN f.b ELSE f.a END) WHERE f.a=? OR f.b=?').all(me, me, me);
      const friends = fr.map(r => ({ id: r.uid, username: r.username, status: r.status === 'ok' ? 'ok' : (r.b === me ? 'in' : 'out') }));
      const messages = db.prepare('SELECT f "from", t "to", text, ts FROM messages WHERE f=? OR t=? ORDER BY ts DESC LIMIT 2000').all(me, me).reverse();
      return out(res, 200, { me: u, friends, messages });
    }
    if (p === '/api/friends' && req.method === 'POST') {
      const t = db.prepare('SELECT id FROM users WHERE username=?').get(String(b.username || '').trim());
      if (!t) return out(res, 404, { error: 'Пользователь не найден' });
      if (t.id === me) return out(res, 400, { error: 'Это вы сами' });
      const ex = db.prepare('SELECT * FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').get(me, t.id, t.id, me);
      if (!ex) db.prepare("INSERT INTO friends VALUES(?,?,'pending')").run(me, t.id);
      else if (ex.status === 'pending' && ex.a === t.id) db.prepare("UPDATE friends SET status='ok' WHERE a=? AND b=?").run(t.id, me);
      else return out(res, 409, { error: 'Заявка уже отправлена или вы уже друзья' });
      push(t.id, { t: 'sync' }); return out(res, 200, { ok: 1 });
    }
    if (p === '/api/friends/accept' && req.method === 'POST') {
      db.prepare("UPDATE friends SET status='ok' WHERE a=? AND b=? AND status='pending'").run(+b.id, me);
      push(+b.id, { t: 'sync' }); return out(res, 200, { ok: 1 });
    }
    if (p.startsWith('/api/friends/') && req.method === 'DELETE') {
      const o = +p.split('/').pop();
      db.prepare('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').run(me, o, o, me);
      push(o, { t: 'sync' }); return out(res, 200, { ok: 1 });
    }
    if (p === '/api/messages' && req.method === 'POST') {
      const to = +b.to, text = String(b.text || '').slice(0, 4000);
      if (!to || !text.trim()) return out(res, 400, { error: 'Пустое сообщение' });
      if (!db.prepare("SELECT 1 FROM friends WHERE status='ok' AND ((a=? AND b=?) OR (a=? AND b=?))").get(me, to, to, me)) return out(res, 403, { error: 'Писать можно только друзьям' });
      const ts = Date.now(); db.prepare('INSERT INTO messages(f,t,text,ts) VALUES(?,?,?,?)').run(me, to, text, ts);
      push(to, { t: 'msg', m: { from: me, text, ts } }); return out(res, 200, { ok: 1 });
    }
    out(res, 404, { error: 'Не найдено' });
  } catch (e) { out(res, 400, { error: 'Некорректный запрос' }); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x'), id = verify(u.searchParams.get('token'));
  const og = req.headers.origin;
  if (u.pathname !== '/ws' || !id || (og && new URL(og).host !== req.headers.host)) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (w) => {
    if (!socks.has(id)) socks.set(id, new Set()); socks.get(id).add(w);
    w.on('close', () => socks.get(id).delete(w)); w.on('error', () => {});
  });
});
server.listen(PORT, () => console.log('Liks server on :' + PORT));
