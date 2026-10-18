// Запуск: node server.js  (Node 18+, без зависимостей). Открыть: http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const DB_F = path.join(__dirname, 'data.json'), PORT = process.env.PORT || 3000;
let db = { users: [], friends: [], rooms: [], msgs: [], tokens: {}, seq: 1 };
try { db = JSON.parse(fs.readFileSync(DB_F, 'utf8')); } catch (e) {}
let tm; const save = () => { clearTimeout(tm); tm = setTimeout(() => fs.writeFile(DB_F, JSON.stringify(db), () => {}), 300); };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const J = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const err = (res, m, c = 400) => J(res, c, { error: m });
const uname = id => (db.users.find(u => u.id == id) || {}).username || '?';
const rel = (a, b) => db.friends.find(f => (f.a == a && f.b == b) || (f.a == b && f.b == a));
const roomOf = id => db.rooms.find(r => r.id === id);
const RX = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

function view(u) {
  const friends = db.users.filter(x => x.id != u).map(x => ({ id: x.id, username: x.username, status: 'ok' }));
  const rooms = db.rooms.filter(r => r.members.includes(u)).map(r => ({
    id: r.id, name: r.name, type: r.type, handle: r.handle || '', admin: r.owner == u, n: r.members.length,
    emoji: r.type === 'channel' ? '📢' : '👥'
  }));
  return { friends, rooms, fv: friends.map(f => f.id + f.status).join() + '|' + rooms.map(r => r.id + r.name + r.n).join() };
}
const visible = (m, u) => typeof m.to === 'string'
  ? !!(roomOf(m.to) && roomOf(m.to).members.includes(u)) : (m.from == u || m.to == u);

const routes = {
  'POST /api/register': (b, u, res) => {
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.username || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return err(res, 'Некорректная почта');
    if (!RX.test(name)) return err(res, 'Юзернейм: латиница, цифры и _, от 5 символов');
    if (String(b.password || '').length < 8) return err(res, 'Пароль — минимум 8 символов');
    if (db.users.some(x => x.email === email)) return err(res, 'Эта почта уже зарегистрирована');
    if (db.users.some(x => x.username.toLowerCase() === name.toLowerCase())) return err(res, 'Юзернейм занят');
    const salt = crypto.randomBytes(8).toString('hex'), user = { id: db.seq++, email, username: name, salt, h: hash(b.password, salt) };
    db.users.push(user); joinAll(user.id); return token(res, user);
  },
  'POST /api/login': (b, u, res) => {
    const x = db.users.find(v => v.email === String(b.email || '').trim().toLowerCase());
    if (!x || x.h !== hash(String(b.password || ''), x.salt)) return err(res, 'Неверная почта или пароль', 401);
    token(res, x);
  },
  'GET /api/sync': (b, u, res) => J(res, 200, {
    me: { id: u, username: uname(u) }, ...view(u),
    messages: db.msgs.filter(m => visible(m, u)).slice(-1000)
  }),
  'GET /api/poll': (b, u, res, q) => J(res, 200, {
    messages: db.msgs.filter(m => m.id > +q.get('since') && m.from != u && visible(m, u)), fv: view(u).fv
  }),
  'POST /api/friends': (b, u, res) => {
    const o = db.users.find(x => x.username.toLowerCase() === String(b.username || '').toLowerCase());
    if (!o) return err(res, 'Пользователь не найден');
    if (o.id == u) return err(res, 'Это вы');
    const r = rel(u, o.id);
    if (r) { if (!r.ok && r.b == u) r.ok = true; else return err(res, 'Заявка уже есть'); }
    else db.friends.push({ a: u, b: o.id, ok: false });
    save(); J(res, 200, { ok: 1 });
  },
  'POST /api/friends/accept': (b, u, res) => {
    const r = rel(b.id, u); if (!r || r.ok || r.b != u) return err(res, 'Заявка не найдена');
    r.ok = true; save(); J(res, 200, { ok: 1 });
  },
  'POST /api/messages': (b, u, res) => {
    const text = String(b.text || '').trim().slice(0, 4000); if (!text) return err(res, 'Пустое сообщение');
    let to = b.to;
    if (typeof to === 'string' && /^r\d+$/.test(to)) {
      const r = roomOf(to);
      if (!r || !r.members.includes(u)) return err(res, 'Вы не в этом чате', 403);
      if (r.type === 'channel' && r.owner != u) return err(res, 'В канал пишет только автор', 403);
    } else {
      to = +to; if (!db.users.some(x => x.id === to)) return err(res, 'Пользователь не найден', 404);
    }
    const m = { id: db.seq++, from: u, to, text, ts: Date.now(), fn: uname(u) };
    db.msgs.push(m); save(); J(res, 200, m);
  },
  'POST /api/rooms': (b, u, res) => {
    const name = String(b.name || '').trim().slice(0, 64); if (!name) return err(res, 'Введите название');
    const type = b.type === 'channel' ? 'channel' : 'group';
    let handle = String(b.handle || '').trim().replace(/^@/, '').toLowerCase();
    if (handle) {
      if (type !== 'channel' || !RX.test(handle)) return err(res, 'Имя канала: латиница, цифры и _, от 5 символов');
      if (db.rooms.some(r => r.handle === handle)) return err(res, 'Это имя занято');
    }
    const ms = [...new Set([u, ...(b.members || []).map(Number).filter(id => db.users.some(x => x.id === id))])];
    const r = { id: 'r' + db.seq++, type, name, handle, owner: u, members: ms };
    db.rooms.push(r); save(); J(res, 200, { id: r.id });
  },
  'POST /api/rooms/join': (b, u, res) => {
    const r = db.rooms.find(x => x.type === 'channel' && x.handle && x.handle === String(b.handle || '').trim().replace(/^@/, '').toLowerCase());
    if (!r) return err(res, 'Канал не найден');
    if (!r.members.includes(u)) r.members.push(u);
    save(); J(res, 200, { id: r.id });
  }
};

function token(res, user) {
  const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = user.id; save(); J(res, 200, { token: t });
}

// Общий чат r0: в нём состоят все пользователи
function joinAll(id) { const g = roomOf('r0'); if (g && !g.members.includes(id)) g.members.push(id); }
if (!roomOf('r0')) db.rooms.unshift({ id: 'r0', type: 'group', name: 'Общий чат', handle: '', owner: 0, members: [] });
db.users.forEach(x => joinAll(x.id)); save();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<head>', '<head><script>window.USE_SERVER=true</script>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = body ? JSON.parse(body) : {}; } catch (e) {}
    const key = req.method + ' ' + url.pathname, open = key === 'POST /api/register' || key === 'POST /api/login';
    const u = db.tokens[(req.headers.authorization || '').slice(7)];
    if (!url.pathname.startsWith('/api/')) return err(res, 'Not found', 404);
    if (!open && !u) return err(res, 'Нужно войти', 401);
    try {
      if (routes[key]) return routes[key](b, u, res, url.searchParams);
      let m;
      if (req.method === 'DELETE' && (m = url.pathname.match(/^\/api\/friends\/(\d+)$/))) {
        db.friends = db.friends.filter(f => !((f.a == u && f.b == m[1]) || (f.b == u && f.a == m[1]))); save(); return J(res, 200, { ok: 1 });
      }
      if ((req.method === 'POST' || req.method === 'GET') && (m = url.pathname.match(/^\/api\/rooms\/(r\d+)\/(members|leave)$/))) {
        const r = roomOf(m[1]); if (!r || !r.members.includes(u)) return err(res, 'Чат не найден', 404);
        if (req.method === 'GET') return J(res, 200, { members: r.members.map(id => ({ id, username: uname(id) })) });
        if (m[2] === 'members') {
          if (r.type === 'channel' && r.owner != u) return err(res, 'Добавлять может только автор', 403);
          (b.ids || []).map(Number).forEach(id => { if (db.users.some(x => x.id === id) && !r.members.includes(id)) r.members.push(id); });
        } else {
          if (r.id === 'r0') return err(res, 'Из общего чата выйти нельзя');
          r.members = r.members.filter(x => x != u);
          if (!r.members.length) db.rooms = db.rooms.filter(x => x !== r); else if (r.owner == u) r.owner = r.members[0];
        }
        save(); return J(res, 200, { ok: 1 });
      }
      err(res, 'Not found', 404);
    } catch (e) { err(res, 'Ошибка сервера', 500); }
  });
}).listen(PORT, () => console.log('Мессенджер: http://localhost:' + PORT));
