// Worker Payroll server: serves the app, handles employer and worker logins, stores data in DATA_DIR.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "payroll.json");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const WORKER_AUTH_FILE = path.join(DATA_DIR, "worker-auth.json"); // workerId -> { salt, hash }
// Kept apart from payroll.json so the employer's full-data saves never overwrite a new request
const REQUESTS_FILE = path.join(DATA_DIR, "advance-requests.json");
const SESSION_HOURS = 12;
fs.mkdirSync(DATA_DIR, { recursive: true });

const sessions = new Map(); // token -> { exp, role: "admin" | "worker", workerId }
const failures = new Map(); // ip -> { count, until }

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/jspdf.umd.min.js": ["node_modules/jspdf/dist/jspdf.umd.min.js", "application/javascript"],
  "/fonts/Roboto-Regular.ttf": ["fonts/Roboto-Regular.ttf", "font/ttf"],
  "/fonts/Roboto-Bold.ttf": ["fonts/Roboto-Bold.ttf", "font/ttf"],
  "/fonts/Roboto-Italic.ttf": ["fonts/Roboto-Italic.ttf", "font/ttf"],
};

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
function writeJson(f, obj) {
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, f);
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const makeHash = (pw) => { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: hashPw(pw, salt) }; };
function matches(pw, a) {
  if (!a) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPw(pw, a.salt), "hex"), Buffer.from(a.hash, "hex"));
}
const checkPw = (pw) => matches(pw, readJson(AUTH_FILE, null));
// Installs from before usernames existed use "admin"
const adminUser = () => readJson(AUTH_FILE, {}).username || "admin";
const sameUser = (u) => String(u || "").trim().toLowerCase() === adminUser().toLowerCase();
const setPw = (pw, username = adminUser()) => writeJson(AUTH_FILE, { username, ...makeHash(pw) });
const validUser = (u) => typeof u === "string" && /^[A-Za-z0-9._-]{3,32}$/.test(u.trim());
const normId = (s) => String(s || "").replace(/\s+/g, "");

function sessionOf(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return { token: m[1], ...s };
}
// Behind the reverse proxy (HTTPS on the internet) the proxy reports the scheme and client address.
// Those headers are trusted only from private network addresses, where the proxy lives.
const isPrivate = (a) => /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$/.test(a || "");
const viaHttps = (req) => isPrivate(req.socket.remoteAddress) && req.headers["x-forwarded-proto"] === "https";
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return isPrivate(req.socket.remoteAddress) && fwd ? fwd : req.socket.remoteAddress;
}
function newSession(res, role, workerId) {
  const t = crypto.randomBytes(32).toString("hex");
  sessions.set(t, { exp: Date.now() + SESSION_HOURS * 3600e3, role, workerId });
  const secure = viaHttps(res.req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}
function send(res, code, body, type = "application/json") {
  const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
  if (viaHttps(res.req)) headers["Strict-Transport-Security"] = "max-age=31536000";
  res.writeHead(code, headers);
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 20e6) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); } });
  });
}
// Returns an error message while an IP is locked out after repeated wrong passwords
function lockedOut(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now() ? "Too many attempts. Wait a minute and try again." : null;
}
function recordFailure(ip) {
  const n = (failures.get(ip)?.count || 0) + 1;
  failures.set(ip, { count: n, until: n >= 5 ? Date.now() + 60e3 : 0 });
}

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const ip = clientIp(req);
  try {
    if (req.method === "GET" && STATIC[url]) {
      const [file, type] = STATIC[url];
      return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type);
    }
    if (url === "/api/status") {
      const s = sessionOf(req);
      return send(res, 200, { setup: !fs.existsSync(AUTH_FILE), loggedIn: !!s, role: s?.role || null });
    }

    if (url === "/api/login" && req.method === "POST") {
      const locked = lockedOut(ip);
      if (locked) return send(res, 429, { error: locked });
      const { username, password } = await readBody(req);
      if (typeof password !== "string" || password.length < 4) return send(res, 400, { error: "Use at least 4 characters." });
      if (!fs.existsSync(AUTH_FILE)) {
        if (!validUser(username)) return send(res, 400, { error: "Username must be 3 to 32 letters, numbers, dots, dashes or underscores." });
        setPw(password, username.trim());
      } else if (!sameUser(username) || !checkPw(password)) {
        // One sign-in form for everyone: if it isn't the employer, try a worker by ID card number
        const data = readJson(DATA_FILE, { workers: [] });
        const w = data.workers.find(x => normId(x.idNo) && normId(x.idNo) === normId(username));
        if (w && matches(password, readJson(WORKER_AUTH_FILE, {})[w.id])) {
          failures.delete(ip);
          newSession(res, "worker", w.id);
          return send(res, 200, { ok: true, role: "worker" });
        }
        recordFailure(ip);
        return send(res, 401, { error: "Wrong username or password. Try again." });
      }
      failures.delete(ip);
      newSession(res, "admin");
      return send(res, 200, { ok: true, role: "admin" });
    }

    if (url === "/api/worker-login" && req.method === "POST") {
      const locked = lockedOut(ip);
      if (locked) return send(res, 429, { error: locked });
      const { qid, password } = await readBody(req);
      const data = readJson(DATA_FILE, { workers: [] });
      const w = data.workers.find(x => normId(x.idNo) && normId(x.idNo) === normId(qid));
      const auth = readJson(WORKER_AUTH_FILE, {});
      if (!w || typeof password !== "string" || !matches(password, auth[w.id])) {
        recordFailure(ip);
        return send(res, 401, { error: "ID card number or password is wrong." });
      }
      failures.delete(ip);
      newSession(res, "worker", w.id);
      return send(res, 200, { ok: true, role: "worker" });
    }

    const sess = sessionOf(req);
    if (url.startsWith("/api/") && !sess) return send(res, 401, { error: "Please log in." });

    if (url === "/api/logout" && req.method === "POST") {
      sessions.delete(sess.token);
      res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
      return send(res, 200, { ok: true });
    }

    // Worker: only their own payslips
    if (url === "/api/my-slips" && req.method === "GET") {
      if (sess.role !== "worker") return send(res, 403, { error: "Not allowed." });
      const data = readJson(DATA_FILE, { workers: [], slips: [], settings: {} });
      const w = data.workers.find(x => x.id === sess.workerId);
      if (!w) return send(res, 401, { error: "Please log in." });
      return send(res, 200, {
        worker: { name: w.name, idNo: w.idNo, job: w.job },
        settings: data.settings,
        slips: data.slips.filter(s => s.worker?.id === w.id),
        requests: readJson(REQUESTS_FILE, []).filter(r => r.workerId === w.id),
      });
    }
    if (url === "/api/requests/seen" && req.method === "POST") {
      if (sess.role !== "worker") return send(res, 403, { error: "Not allowed." });
      const all = readJson(REQUESTS_FILE, []);
      all.forEach(r => { if (r.workerId === sess.workerId && r.status !== "pending") r.seen = true; });
      writeJson(REQUESTS_FILE, all);
      return send(res, 200, { ok: true });
    }
    if (url === "/api/advance-request" && req.method === "POST") {
      if (sess.role !== "worker") return send(res, 403, { error: "Not allowed." });
      const { amount, reason } = await readBody(req);
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!(amt > 0 && amt <= 1e6)) return send(res, 400, { error: "Enter an amount greater than zero." });
      const data = readJson(DATA_FILE, { workers: [] });
      const w = data.workers.find(x => x.id === sess.workerId);
      if (!w) return send(res, 401, { error: "Please log in." });
      const all = readJson(REQUESTS_FILE, []);
      if (all.filter(r => r.workerId === w.id && r.status === "pending").length >= 3)
        return send(res, 400, { error: "You already have 3 requests waiting. Wait for a reply first." });
      const r = { id: crypto.randomBytes(8).toString("hex"), workerId: w.id, name: w.name, idNo: w.idNo, amount: amt,
        reason: String(reason || "").slice(0, 300), status: "pending", created: new Date().toISOString() };
      all.unshift(r);
      writeJson(REQUESTS_FILE, all);
      return send(res, 200, r);
    }

    // Everything below is for the employer only
    if (url.startsWith("/api/") && sess.role !== "admin") return send(res, 403, { error: "Not allowed." });

    if (url === "/api/account" && req.method === "GET") return send(res, 200, { username: adminUser() });
    if (url === "/api/password" && req.method === "POST") {
      const { current, next, username } = await readBody(req);
      if (!checkPw(String(current || ""))) return send(res, 401, { error: "Current password is wrong." });
      if (next && (typeof next !== "string" || next.length < 4)) return send(res, 400, { error: "Use at least 4 characters." });
      if (!validUser(username)) return send(res, 400, { error: "Username must be 3 to 32 letters, numbers, dots, dashes or underscores." });
      setPw(next || String(current), username.trim());
      for (const [t, s] of sessions) if (s.role === "admin") sessions.delete(t);
      newSession(res, "admin");
      return send(res, 200, { ok: true });
    }
    if (url === "/api/worker-access" && req.method === "GET") return send(res, 200, Object.keys(readJson(WORKER_AUTH_FILE, {})));
    if (url === "/api/worker-password" && req.method === "POST") {
      const { workerId, password } = await readBody(req);
      if (typeof workerId !== "string" || !workerId) return send(res, 400, { error: "Invalid data." });
      const auth = readJson(WORKER_AUTH_FILE, {});
      if (password === "") delete auth[workerId];
      else if (typeof password !== "string" || password.length < 4) return send(res, 400, { error: "Use at least 4 characters." });
      else auth[workerId] = makeHash(password);
      writeJson(WORKER_AUTH_FILE, auth);
      // Sign the worker out everywhere when their access changes
      for (const [t, s] of sessions) if (s.role === "worker" && s.workerId === workerId) sessions.delete(t);
      return send(res, 200, { ok: true });
    }
    if (url === "/api/requests" && req.method === "GET") return send(res, 200, readJson(REQUESTS_FILE, []));
    if (url === "/api/requests/decide" && req.method === "POST") {
      const { id, status, note } = await readBody(req);
      if (!["approved", "rejected", "pending"].includes(status)) return send(res, 400, { error: "Invalid data." });
      const all = readJson(REQUESTS_FILE, []);
      const r = all.find(x => x.id === id);
      if (!r) return send(res, 404, { error: "Not found" });
      // seen: false makes the worker's page show a notice until they acknowledge it
      Object.assign(r, { status, note: String(note || "").slice(0, 300), decided: status === "pending" ? null : new Date().toISOString(), seen: status === "pending" });
      writeJson(REQUESTS_FILE, all);
      return send(res, 200, r);
    }
    if (url === "/api/data" && req.method === "GET") return send(res, 200, readJson(DATA_FILE, null));
    if (url === "/api/data" && req.method === "PUT") {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.workers) || !Array.isArray(body.slips)) return send(res, 400, { error: "Invalid data." });
      writeJson(DATA_FILE, body);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => console.log(`Worker Payroll on :${PORT}, data in ${DATA_DIR}`));
