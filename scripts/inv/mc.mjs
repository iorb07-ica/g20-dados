// Investigação (28/10/2026): roda o motor do site e o motor em teste na Minha Carteira do admin e
// devolve o resultado CIFRADO (só a sessão de investigação lê).
import fs from 'node:fs'; import vm from 'node:vm'; import crypto from 'node:crypto'; import zlib from 'node:zlib'; import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore(); const dados = db.collection('users').doc('8xrwHHEKAmd0Us5MCyBJhtkJVBM2').collection('dados');
const val = async k => { const d = await dados.doc(k).get(); return d.exists ? (d.data().value || []) : []; };
const ap = await val('rvAportes'), pv = await val('rvDividendos'), rf = await val('rendaFixa'), fu = await val('fundos');
const _f = globalThis.fetch;
globalThis.fetch = (u, o = {}) => { o = Object.assign({}, o); const h = { 'User-Agent': 'Mozilla/5.0 Chrome/124', Accept: 'application/json,text/plain,*/*' };
  if (/g20-proxy/.test(String(u))) { h.Origin = 'https://g20hub.com'; h.Referer = 'https://g20hub.com/gestao-patrimonial.html'; } o.headers = Object.assign(h, o.headers || {}); return _f(u, o); };
const mem = {}; globalThis.window = globalThis;
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; }, key: i => Object.keys(mem)[i] || null, get length() { return Object.keys(mem).length; }, clear: () => { for (const k in mem) delete mem[k]; } };
globalThis.G20Ind = { get: (k, d) => d };
const out = { em: new Date().toISOString(), n: { ap: ap.length, pv: pv.length, rf: rf.length, fu: fu.length }, motores: {} };
for (const [nome, url] of [['site', 'https://g20hub.com/assets/g20-rent.js'], ['teste', process.env.TESTE_URL]]) {
  try {
    const src = await (await _f(url + '?t=' + Date.now())).text(); delete globalThis.G20Rent; vm.runInThisContext(src, { filename: nome + '.js' });
    const G = globalThis.G20Rent; localStorage.setItem('g20_rvAportes', JSON.stringify(ap)); localStorage.setItem('g20_rendaFixa', JSON.stringify(rf));
    const serie = await G.calcular({ aportes: ap, proventos: pv, rendaFixa: rf, fundos: fu, _semGravar: true });
    const D = serie.map(p => p.d), anos = [...new Set(D.map(d => d.slice(0, 4)))];
    const r = { total: G.twrDesde(serie, D[0]), anos: {}, ignorados: [], serie: serie.map(p => [p.d, Math.round(p.patrimonio), Math.round(p.fluxo || 0), Math.round(p.prov || 0), +(p.cobertura || 1).toFixed(4), p.sx === undefined ? null : p.sx]) };
    anos.forEach(y => { const ini = D.filter(d => d < y + '-01-01').pop() || D[0]; r.anos[y] = G.twrDesde(serie.filter(p => p.d <= y + '-12-31'), ini); });
    out.motores[nome] = r;
  } catch (e) { out.motores[nome] = { erro: String(e && e.stack || e) }; }
}
const txt = zlib.gzipSync(Buffer.from(JSON.stringify(out)));
const chave = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', chave, iv);
const corpo = Buffer.concat([c.update(txt), c.final()]), tag = c.getAuthTag();
const ck = crypto.publicEncrypt({ key: fs.readFileSync(new URL('./pub.pem', import.meta.url)), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, chave);
fs.mkdirSync('dados/inv', { recursive: true }); fs.writeFileSync('dados/inv/mc.bin', Buffer.concat([Buffer.from([ck.length >> 8, ck.length & 255]), ck, iv, tag, corpo]));
console.log('pronto');
