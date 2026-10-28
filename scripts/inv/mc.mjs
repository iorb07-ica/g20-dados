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
    // dias de aporte: decomposição (mercado das posições do dia anterior × diferença de preço das compras)
    if (nome === 'teste') { const px = globalThis._g20Precos || {}, cb = globalThis._g20Cambio, ops = ap.slice().sort((a, b) => String(a.data).localeCompare(String(b.data)));
      const US = new Set(['STOCK', 'REIT', 'ETF', 'UCITS', 'CRIPTO']); const q = {}; let k = 0; r.dias = [];
      for (let i = 1; i < serie.length; i++) { const d0 = serie[i - 1].d, d1 = serie[i].d;
        const doDia = []; while (k < ops.length && String(ops[k].data).slice(0, 10) <= d1) { const a = ops[k++]; if (String(a.data).slice(0, 10) <= d0) { const t = String(a.ticker).toUpperCase(); q[t] = (q[t] || 0) + (a.op === 'V' ? -1 : 1) * (+a.qtd || 0); continue; } doDia.push(a); }
        if (doDia.length && Math.abs(serie[i].fluxo || 0) > 1) { const fx0 = cb ? cb.em(d0) : null, fx1 = cb ? cb.em(d1) : null; let mk = 0, v0 = 0;
          for (const t in q) { if (!(q[t] > 0) || !px[t]) continue; const a0 = px[t].em(d0), a1 = px[t].em(d1); if (!(a0 > 0 && a1 > 0)) continue; const us = US.has(String((ap.find(x => String(x.ticker).toUpperCase() === t) || {}).tipo || '').toUpperCase()); v0 += q[t] * a0 * (us ? fx0 : 1); mk += q[t] * (a1 * (us ? fx1 : 1) - a0 * (us ? fx0 : 1)); }
          const comp = doDia.map(a => { const t = String(a.ticker).toUpperCase(), c1 = px[t] ? px[t].em(d1) : null; return [t, a.op, +a.qtd, +a.preco, a.moeda || '', +a.fxRate || null, c1, fx1, a.tipo]; });
          r.dias.push([d1, serie[i - 1].patrimonio, serie[i].patrimonio, serie[i].fluxo, v0 ? mk / v0 : null, comp]); }
        doDia.forEach(a => { const t = String(a.ticker).toUpperCase(); q[t] = (q[t] || 0) + (a.op === 'V' ? -1 : 1) * (+a.qtd || 0); }); } }
    out.motores[nome] = r;
  } catch (e) { out.motores[nome] = { erro: String(e && e.stack || e) }; }
}
const txt = zlib.gzipSync(Buffer.from(JSON.stringify(out)));
const chave = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', chave, iv);
const corpo = Buffer.concat([c.update(txt), c.final()]), tag = c.getAuthTag();
const ck = crypto.publicEncrypt({ key: fs.readFileSync(new URL('./pub.pem', import.meta.url)), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, chave);
fs.mkdirSync('dados/inv', { recursive: true }); fs.writeFileSync('dados/inv/mc.bin', Buffer.concat([Buffer.from([ck.length >> 8, ck.length & 255]), ck, iv, tag, corpo]));
console.log('pronto');
