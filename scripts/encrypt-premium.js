// Usage : PREMIUM_KEY=<base64 de 32 octets> node scripts/encrypt-premium.js source.json premium/P1.enc
const fs = require("fs"), zlib = require("zlib"), crypto = require("crypto");
const [src, out] = process.argv.slice(2);
const k = Buffer.from(process.env.PREMIUM_KEY || "", "base64");
if (!src || !out || k.length !== 32) { console.error("Usage: PREMIUM_KEY=... node scripts/encrypt-premium.js source.json sortie.enc"); process.exit(1); }
JSON.parse(fs.readFileSync(src, "utf8"));
const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k, iv);
const enc = Buffer.concat([c.update(zlib.gzipSync(fs.readFileSync(src))), c.final()]);
fs.writeFileSync(out, Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"));
console.log("OK", out, enc.length, "octets chiffrés");
