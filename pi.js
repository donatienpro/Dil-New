// Routes Pi Network de DIL : vérification de la connexion et reprise des paiements inachevés.
// Aucune dépendance. Variables : PI_API_KEY (paiements), SESSION_SECRET (signature des sessions), PI_API_BASE (tests).
const crypto = require("crypto");
const premium = require("./premium");

const PI_API = (process.env.PI_API_BASE || "https://api.minepi.com").replace(/\/$/, "");
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"); // sans variable, les sessions tombent à chaque redémarrage
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET absent : les sessions seront invalidées à chaque redémarrage");
const TTL = 7 * 24 * 3600 * 1000;

// Administrateurs : décidés par le serveur (variables ADMIN_UIDS et ADMIN_USERNAMES, séparées par des virgules).
// Par défaut, le nom d'utilisateur Pi ADONASGO est administrateur ; l'identifiant (uid) est plus sûr : à renseigner dans ADMIN_UIDS.
const list = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const ADMIN_UIDS = list(process.env.ADMIN_UIDS);
const ADMIN_NAMES = list(process.env.ADMIN_USERNAMES === undefined ? "ADONASGO" : process.env.ADMIN_USERNAMES);
const isAdmin = (u) => !!u && (ADMIN_UIDS.includes(String(u.uid).toLowerCase()) || (!!u.username && ADMIN_NAMES.includes(String(u.username).toLowerCase())));
// Compteurs en mémoire (remis à zéro à chaque redémarrage). Aucun nom ni identifiant n'est conservé : seulement un nombre.
const STATS = { since: Date.now(), logins: 0, uids: new Set(), payments: 0 };

const b64 = (b) => Buffer.from(b).toString("base64url");
const mac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeSession(u) { const p = b64(JSON.stringify({ uid: u.uid, username: u.username, exp: Date.now() + TTL })); return p + "." + mac(p); }
function readSession(h) {
  const m = /^Bearer\s+(\S+)$/.exec(h || ""); if (!m) return null;
  const [p, s] = m[1].split("."); if (!p || !s) return null;
  const a = Buffer.from(mac(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() && d.uid ? d : null; } catch { return null; }
}

// Catalogue des produits : le prix est fixé ICI, par le serveur, jamais par le navigateur.
const CATALOG = { test: { amount: 0.1, memo: "DIL - paiement de test (Testnet)" } };
const sameAmt = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
function makeReceipt(o) { const p = b64(JSON.stringify(Object.assign({ t: "receipt", at: Date.now() }, o))); return p + "." + mac(p); }

async function piFetch(path, opts) {
  const r = await fetch(PI_API + path, Object.assign({ signal: AbortSignal.timeout(15000) }, opts));
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: d };
}
const keyHeaders = () => ({ Authorization: "Key " + process.env.PI_API_KEY, "Content-Type": "application/json" });

async function readBody(req, send, res) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 4096) { send(res, 413, { error: "too_large" }); return null; } }
  try { return JSON.parse(raw || "{}"); } catch { send(res, 400, { error: "bad_json" }); return null; }
}

// Retourne true si la route a été traitée.
async function handle(req, res, url, h) {
  if (!url.startsWith("/api/auth/") && url !== "/api/me" && !url.startsWith("/api/payments/") && !url.startsWith("/api/admin/") && !url.startsWith("/api/premium/")) return false;
  if (!h.cors(req, res)) { h.send(res, 403, { error: "origin_refused" }); return true; }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  if (h.limited(ip)) { h.send(res, 429, { error: "rate_limited" }); return true; }

  // 1) Connexion : le navigateur envoie l'accessToken, le serveur le fait vérifier par Pi (GET /v2/me).
  if (url === "/api/auth/verify" && req.method === "POST") {
    const body = await readBody(req, h.send, res); if (!body) return true;
    const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    if (!token || token.length > 4000) { h.send(res, 400, { error: "bad_request" }); return true; }
    try {
      const r = await piFetch("/v2/me", { headers: { Authorization: "Bearer " + token } });
      if (r.status === 401 || r.status === 403) { h.send(res, 401, { error: "invalid_token" }); return true; }
      if (!r.ok || !r.data || !r.data.uid) { console.error("pi /me", r.status); h.send(res, 502, { error: "pi_error" }); return true; }
      const user = { uid: String(r.data.uid), username: String(r.data.username || "") };
      STATS.logins++; if (STATS.uids.size < 100000) STATS.uids.add(crypto.createHash("sha256").update(user.uid).digest("base64url"));
      h.send(res, 200, { session: makeSession(user), user: Object.assign({}, user, { admin: isAdmin(user) }) });
    } catch (e) { console.error("pi /me", String(e.message).slice(0, 200)); h.send(res, 502, { error: "pi_unreachable" }); }
    return true;
  }

  // Session propre : vérifie qu'un jeton de session émis par ce serveur est encore valide.
  if (url === "/api/me" && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    h.send(res, 200, { user: { uid: s.uid, username: s.username, admin: isAdmin(s) } });
    return true;
  }

  // Contenu Premium : pour l'instant réservé aux administrateurs (les autres l'obtiendront avec la version officielle).
  if (url.startsWith("/api/premium/") && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!isAdmin(s)) { h.send(res, 403, { error: "locked" }); return true; }
    const r = premium.load(url.slice("/api/premium/".length).split("?")[0]);
    if (r.err) { h.send(res, r.err === "not_found" ? 404 : r.err === "bad_id" ? 400 : 503, { error: r.err }); return true; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(r.data); return true;
  }

  // Administration : réservée aux administrateurs, vérifiée à chaque appel par le serveur.
  if (url === "/api/admin/stats" && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!isAdmin(s)) { h.send(res, 403, { error: "forbidden" }); return true; }
    h.send(res, 200, { since: STATS.since, logins: STATS.logins, uniqueUsers: STATS.uids.size, paymentsCompleted: STATS.payments, adminUidsConfigured: ADMIN_UIDS.length > 0, yourUid: s.uid });
    return true;
  }

  // 2) Paiement inachevé trouvé à la connexion : on le termine ou on l'annule, après avoir vérifié qu'il est bien à cet utilisateur.
  if (url === "/api/payments/incomplete" && req.method === "POST") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!process.env.PI_API_KEY) { h.send(res, 503, { error: "not_configured" }); return true; }
    const body = await readBody(req, h.send, res); if (!body) return true;
    const id = typeof body.paymentId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(body.paymentId) ? body.paymentId : "";
    if (!id) { h.send(res, 400, { error: "bad_request" }); return true; }
    try {
      const g = await piFetch("/v2/payments/" + id, { headers: keyHeaders() });
      if (!g.ok) { console.error("payments: GET", g.status, (g.data && g.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      const p = g.data;
      if (String(p.user_uid) !== s.uid) { h.send(res, 403, { error: "not_your_payment" }); return true; }
      const st = p.status || {};
      if (st.developer_completed) { h.send(res, 200, { result: "already_completed" }); return true; }
      if (st.cancelled || st.user_cancelled) { h.send(res, 200, { result: "already_cancelled" }); return true; }
      const txid = p.transaction && p.transaction.txid;
      if (txid) {
        const c = await piFetch("/v2/payments/" + id + "/complete", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ txid }) });
        if (!c.ok) { console.error("payments: complete", c.status, (c.data && c.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
        h.send(res, 200, { result: "completed" }); return true;
      }
      const c = await piFetch("/v2/payments/" + id + "/cancel", { method: "POST", headers: keyHeaders(), body: "{}" });
      if (!c.ok) { console.error("payments: cancel", c.status, (c.data && c.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      h.send(res, 200, { result: "cancelled" });
    } catch (e) { console.error("payments:", String(e.message).slice(0, 200)); h.send(res, 502, { error: "pi_unreachable" }); }
    return true;
  }
  // 3) Paiement : approbation puis complétion, toujours décidées par le serveur après contrôle auprès de Pi.
  if ((url === "/api/payments/approve" || url === "/api/payments/complete") && req.method === "POST") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!process.env.PI_API_KEY) { h.send(res, 503, { error: "not_configured" }); return true; }
    const body = await readBody(req, h.send, res); if (!body) return true;
    const id = typeof body.paymentId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(body.paymentId) ? body.paymentId : "";
    if (!id) { h.send(res, 400, { error: "bad_request" }); return true; }
    try {
      const g = await piFetch("/v2/payments/" + id, { headers: keyHeaders() });
      if (!g.ok) { console.error("payments: GET", g.status, (g.data && g.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      const p = g.data, st = p.status || {};
      if (String(p.user_uid) !== s.uid) { h.send(res, 403, { error: "not_your_payment" }); return true; }
      const key = p.metadata && p.metadata.product, prod = typeof key === "string" && Object.prototype.hasOwnProperty.call(CATALOG, key) ? CATALOG[key] : null;
      if (!prod || !sameAmt(p.amount, prod.amount)) { console.error("payments: produit ou montant refusé", key, p.amount); h.send(res, 400, { error: "bad_product" }); return true; }
      if (st.cancelled || st.user_cancelled) { h.send(res, 409, { error: "cancelled" }); return true; }
      if (url === "/api/payments/approve") {
        if (st.developer_approved) { h.send(res, 200, { result: "already_approved" }); return true; }
        const a = await piFetch("/v2/payments/" + id + "/approve", { method: "POST", headers: keyHeaders(), body: "{}" });
        if (!a.ok) { console.error("payments: approve", a.status, (a.data && a.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
        h.send(res, 200, { result: "approved" }); return true;
      }
      const txid = typeof body.txid === "string" && /^[A-Za-z0-9]{6,128}$/.test(body.txid) ? body.txid : "";
      if (!txid) { h.send(res, 400, { error: "bad_request" }); return true; }
      const ptx = p.transaction && p.transaction.txid;
      if (st.developer_completed) { h.send(res, 200, { result: "already_completed", receipt: makeReceipt({ uid: s.uid, product: key, paymentId: id, txid: ptx || txid }) }); return true; }
      if (!st.developer_approved) { h.send(res, 409, { error: "not_approved" }); return true; }
      if (ptx !== txid) { console.error("payments: txid différent"); h.send(res, 400, { error: "txid_mismatch" }); return true; }
      const c = await piFetch("/v2/payments/" + id + "/complete", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ txid }) });
      if (!c.ok) { console.error("payments: complete", c.status, (c.data && c.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      STATS.payments++;
      h.send(res, 200, { result: "completed", receipt: makeReceipt({ uid: s.uid, product: key, paymentId: id, txid }) });
    } catch (e) { console.error("payments:", String(e.message).slice(0, 200)); h.send(res, 502, { error: "pi_unreachable" }); }
    return true;
  }
  h.send(res, 404, { error: "not_found" }); return true;
}
module.exports = { handle, CATALOG };
