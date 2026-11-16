// API de l'assistant IA de DIL. Aucune dépendance. Les clés restent dans les variables d'environnement.
// Variables : ANTHROPIC_API_KEY ou GEMINI_API_KEY (au moins une), ALLOWED_ORIGINS, CHAT_MODEL, DAILY_CAP.
const http = require("http");
const pi = require("./pi");

const PORT = process.env.PORT || 3000;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://dil-digital-learning.onrender.com").split(",").map((s) => s.trim()).filter(Boolean);
const DAILY_CAP = Number(process.env.DAILY_CAP || 500);
const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const GEMINI_URL = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const LEVELS = { debutant: "Débutant : explique simplement, sans jargon, avec un exemple.", intermediaire: "Intermédiaire : explique clairement, tu peux utiliser les termes courants.", expert: "Expert : sois précis et concis, tu peux utiliser le vocabulaire technique." };

const SYSTEM = `Tu es l'assistant pédagogique de DIL (Digital Investment Learning), une école de cryptomonnaies animée par le formateur AGOSSOU G. DONATIEN. Tu es une intelligence artificielle, jamais un humain.
Règles :
- Réponds dans la langue de l'utilisateur (français par défaut), de façon claire et courte. Utilise des étapes numérotées quand c'est utile.
- Sujets : cryptomonnaies, blockchain, portefeuilles, sécurité, stablecoins, arnaques, bases du trading, DeFi, NFT, Pi Network (informations générales).
- Ton rôle est éducatif. Ne donne jamais de conseil d'achat, de vente ou d'investissement personnalisé, ne prédis jamais un prix et ne promets jamais un gain. Rappelle que tout investissement comporte un risque de perte.
- Ne demande JAMAIS une phrase de récupération, une clé privée ou un mot de passe. Si l'utilisateur en parle, dis-lui de ne jamais les partager.
- Pour le Futures et l'effet de levier, rappelle que le risque de perte rapide est élevé.
- Si tu n'es pas sûr ou si l'information peut avoir changé (prix, règles, disponibilité d'un service), dis-le et invite à vérifier la source officielle.
- Pour un rendez-vous, un paiement ou une question sur son compte, renvoie vers l'onglet Coaching ou le formateur.
- Si la question n'a aucun rapport avec la crypto, la finance ou l'apprentissage, explique poliment que tu ne peux pas aider sur ce sujet.`;

const hits = new Map();
let day = new Date().toDateString(), dayCount = 0;
function limited(ip) {
  const now = Date.now();
  const r = (hits.get(ip) || []).filter((t) => now - t < 60000);
  r.push(now); hits.set(ip, r);
  if (hits.size > 5000) hits.clear();
  return r.length > 15;
}
function overCap() {
  const d = new Date().toDateString();
  if (d !== day) { day = d; dayCount = 0; }
  return ++dayCount > DAILY_CAP;
}

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return true;
  }
  return !o; // appel sans Origin (test serveur) : accepté ; origine inconnue : refusée
}
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

function clean(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  const msgs = body.messages.slice(-8).map((m) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, 1000).trim() })).filter((m) => m.content);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  const level = LEVELS[body.level] ? body.level : "debutant";
  return { msgs, level };
}

async function askAnthropic(system, msgs) {
  const r = await fetch(`${ANTHROPIC_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.CHAT_MODEL || "claude-haiku-5-5", max_tokens: 700, system, messages: msgs }),
    signal: AbortSignal.timeout(25000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("anthropic " + r.status + " " + JSON.stringify(d).slice(0, 200));
  return (d.content || []).map((b) => b.text || "").join("").trim();
}
async function askGemini1(model, system, msgs) {
  const r = await fetch(`${GEMINI_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: { temperature: 0.4, maxOutputTokens: 900 } }),
    signal: AbortSignal.timeout(20000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("gemini " + model + " " + r.status + " " + JSON.stringify(d).slice(0, 200));
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map((p) => p.text || "").join("").trim();
}
async function askGemini(system, msgs) {
  const list = process.env.CHAT_MODEL ? [process.env.CHAT_MODEL] : ["gemini-flash-lite-latest", "gemini-3-flash-preview"];
  let last;
  for (const m of list) {
    try { const t = await askGemini1(m, system, msgs); if (t) return t; } catch (e) { last = e; console.error("model fail:", String(e.message).slice(0, 200)); }
  }
  throw last || new Error("no reply");
}

http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  if (url === "/health") return send(res, 200, { ok: true, configured: !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) });
  if (await pi.handle(req, res, url, { cors, send, limited })) return;
  if (url !== "/api/chat") return send(res, 404, { error: "not_found" });
  if (!cors(req, res)) return send(res, 403, { error: "origin_refused" });
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) return send(res, 503, { error: "not_configured" });

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "rate_limited" });
  if (overCap()) return send(res, 429, { error: "daily_cap" });

  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 16384) return send(res, 413, { error: "too_large" }); }
  let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "bad_json" }); }
  const v = clean(body);
  if (!v) return send(res, 400, { error: "bad_request" });

  try {
    const system = SYSTEM + "\nNiveau de l'utilisateur : " + LEVELS[v.level];
    const reply = process.env.ANTHROPIC_API_KEY ? await askAnthropic(system, v.msgs) : await askGemini(system, v.msgs);
    if (!reply) return send(res, 200, { reply: "Je ne peux pas répondre à cette question. Reformulez-la ou contactez le formateur." });
    return send(res, 200, { reply });
  } catch (e) {
    console.error("chat error:", String(e.message || e).slice(0, 300));
    return send(res, 502, { error: "provider_error" });
  }
}).listen(PORT, () => console.log("DIL API sur le port " + PORT));
