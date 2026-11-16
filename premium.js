// Contenu Premium : fichiers chiffrés (AES-256-GCM) dans premium/*.enc, déchiffrés ici avec PREMIUM_KEY (variable Render).
// Sans la clé, les fichiers publiés dans le dépôt sont illisibles. Format : base64( iv[12] | tag[16] | chiffré(gzip(JSON)) ).
const fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const DIR = path.join(__dirname, "premium");
const cache = new Map();
function key() { const k = process.env.PREMIUM_KEY || ""; const b = Buffer.from(k, "base64"); return b.length === 32 ? b : null; }
function load(id) {
  if (!/^P\d{1,2}$/.test(id)) return { err: "bad_id" };
  if (cache.has(id)) return { data: cache.get(id) };
  const k = key(); if (!k) return { err: "not_configured" };
  const f = path.join(DIR, id + ".enc");
  if (!fs.existsSync(f)) return { err: "not_found" };
  try {
    const raw = Buffer.from(fs.readFileSync(f, "utf8").trim(), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28));
    const json = zlib.gunzipSync(Buffer.concat([d.update(raw.subarray(28)), d.final()])).toString("utf8");
    const data = JSON.parse(json); cache.set(id, json); return { data: json };
  } catch (e) { console.error("premium: déchiffrement impossible", id); return { err: "decrypt_failed" }; }
}
module.exports = { load };
