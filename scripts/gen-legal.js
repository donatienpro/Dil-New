// Génère les pages publiques mentions.html, confidentialite.html et conditions.html à partir des textes de index.html.
// Usage : node scripts/gen-legal.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "index.html"), "utf8");
const m = /const LEG=\{[\s\S]*?\]\};\n/.exec(src);
if (!m) throw new Error("LEG introuvable dans index.html");
const LEG = new Function(m[0] + "return LEG;")();
const FILES = { mentions: "mentions.html", confidentialite: "confidentialite.html", conditions: "conditions.html" };
const nav = (cur) => Object.keys(FILES).map((k) => `<a href="${FILES[k]}"${k === cur ? ' aria-current="page"' : ""}>${LEG[k][0]}</a>`).join("");
for (const k of Object.keys(FILES)) {
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${LEG[k][0]} — DIL</title>
<meta name="description" content="${LEG[k][0]} de Digital Investment Learning (DIL), application éducative sur les cryptomonnaies.">
<style>
:root{--ink:#111;--mut:#5c6b77;--gold:#D4AF37;--sky:#EAF5FD;--bd:#DDEBF5}
*{box-sizing:border-box}body{margin:0;font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:linear-gradient(180deg,#E3F2FC,#F6FAFD 360px) #F6FAFD}
header{background:#fff;border-bottom:1px solid var(--bd);padding:14px 16px}header div{max-width:760px;margin:auto;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
header b{font-size:20px}header a.app{background:#111;color:#F2D77A;text-decoration:none;font-weight:700;border-radius:999px;padding:9px 16px;font-size:15px}
main{max-width:760px;margin:22px auto;padding:0 16px 40px}h1{font-size:30px;line-height:1.2;margin:8px 0 14px}
article{background:#fff;border:1px solid var(--bd);border-radius:22px;padding:6px 20px 14px;box-shadow:0 2px 10px rgba(80,150,200,.07)}
h3{font-size:19px;margin:22px 0 4px}p{margin:8px 0}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}nav a{border:1px solid var(--bd);background:#fff;color:#17496b;border-radius:999px;padding:8px 14px;text-decoration:none;font-weight:600;font-size:15px}nav a[aria-current]{background:linear-gradient(135deg,#F6E19A,#D4AF37);color:#111;border-color:transparent}
footer{max-width:760px;margin:0 auto;padding:0 16px 30px;color:var(--mut);font-size:14px}
</style></head><body>
<header><div><b>DIL · Digital Investment Learning</b><a class="app" href="./">Ouvrir l'application</a></div></header>
<main><nav aria-label="Pages légales">${nav(k)}</nav><h1>${LEG[k][0]}</h1><article>${LEG[k][1]}</article></main>
<footer>Contenu éducatif, pas un conseil financier. Contact : donatien.crypto@gmail.com</footer>
</body></html>
`;
  fs.writeFileSync(path.join(root, FILES[k]), html);
  console.log("écrit", FILES[k], html.length, "octets");
}
