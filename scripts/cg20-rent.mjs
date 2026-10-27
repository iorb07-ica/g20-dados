// Série diária de rentabilidade da Carteira G20 (28/10/2026)
//
// Roda pelo .github/workflows/cg20-rent.yml do repositório PÚBLICO g20-dados (minutos ilimitados),
// todo dia útil às 21h de Brasília. Como os registros deste repositório são públicos, o robô não
// escreve valores em reais: só contagens, datas, tamanho e a rentabilidade em %.
// 1. Lê a "entrada" que a página da Carteira G20 publica quando o admin a abre
//    (users/{admin}/dados/cg20Entrada: lançamentos + proventos já validados,
//    exatamente os que a página usa).
// 2. Calcula a série diária com o MOTOR ÚNICO (assets/g20-rent.js, o mesmo do
//    Dashboard e da Minha Carteira), rodando aqui no Node.
// 3. Grava users/{admin}/dados/cg20Rent comprimido (gzip + base64), com o
//    resultado por ativo de cada período pronto. O aluno só lê.
// Segredo necessário: FIREBASE_SERVICE_ACCOUNT (JSON da conta de serviço).
// MODO=diagnostico calcula e mostra os números sem gravar.
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import admin from 'firebase-admin';

const MOTOR_URL = 'https://g20hub.com/assets/g20-rent.js';   // o motor único, direto do site (já é público)
const ADMIN_UID = '8xrwHHEKAmd0Us5MCyBJhtkJVBM2';
const MODO = (process.env.MODO || 'gravar').trim();
const log = (...a) => console.log(...a);

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
if (!sa) { console.error('Falta o segredo FIREBASE_SERVICE_ACCOUNT.'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const dados = db.collection('users').doc(ADMIN_UID).collection('dados');

// ── o motor do navegador, aqui no Node ─────────────────────────────────────
async function carregarMotor() {
  const mem = {};
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; },
    key: i => Object.keys(mem)[i] || null, get length() { return Object.keys(mem).length; }, clear: () => { for (const k in mem) delete mem[k]; }
  };
  globalThis.G20Ind = { get: (k, d) => d };
  // o Yahoo recusa pedidos sem cara de navegador: o robô se apresenta como um
  const _f = globalThis.fetch;
  globalThis.fetch = (u, o = {}) => { o = Object.assign({}, o); o.headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/json,text/plain,*/*' }, o.headers || {}); return _f(u, o); };
  const r = await fetch(MOTOR_URL + '?t=' + Date.now()); if (!r.ok) throw new Error('motor não baixou: HTTP ' + r.status);
  const src = await r.text();
  vm.runInThisContext(src, { filename: 'g20-rent.js' });
  if (!globalThis.G20Rent) throw new Error('motor não carregou');
  return globalThis.G20Rent;
}

const PERIODOS = { mes: 'mes', '6m': '6m', ano: 'ano', '12m': '12m', '5a': '5a', max: 'max' };
function inicioPer(D, p) {
  const u = new Date(D[D.length - 1] + 'T12:00:00Z'), a = u.getUTCFullYear(), m = u.getUTCMonth(), d = u.getUTCDate();
  const z = (y, mo, da) => new Date(Date.UTC(y, mo, da)).toISOString().slice(0, 10);
  const desde = iso => { for (let i = 0; i < D.length; i++) if (D[i] >= iso) return Math.max(0, i - 1); return 0; };
  if (p === 'mes') return desde(z(a, m, 1)); if (p === '6m') return desde(z(a, m - 6, d)); if (p === 'ano') return desde(z(a, 0, 1));
  if (p === '12m') return desde(z(a - 1, m, d)); if (p === '5a') return desde(z(a - 5, m, d)); return 0;
}

async function main() {
  const t0 = Date.now();
  const doc = await dados.doc('cg20Entrada').get();
  const ent = doc.exists ? (doc.data().value || null) : null;
  if (!ent || !Array.isArray(ent.aportes) || !ent.aportes.length) {
    console.error('Sem cg20Entrada: abra a Carteira G20 como admin uma vez para a página publicar os lançamentos.');
    process.exit(1);
  }
  log(`Entrada: ${ent.aportes.length} lançamentos, ${(ent.proventos || []).length} proventos (publicada em ${ent.em || '?'})`);
  const G = await carregarMotor();
  // o motor confere a "assinatura" dos lançamentos pelo que está guardado no aparelho: aqui são os da Carteira G20
  localStorage.setItem('g20_rvAportes', JSON.stringify(ent.aportes)); localStorage.setItem('g20_rendaFixa', '[]');
  const serie = await G.calcular({ aportes: ent.aportes, proventos: ent.proventos || [], rendaFixa: [], _semGravar: true });
  const px = globalThis._g20Precos || {}, comPx = Object.keys(px).length;
  const tks = [...new Set(ent.aportes.map(x => String(x.ticker).toUpperCase()))];
  const semPx = tks.filter(t => !px[t] && !px[t.replace(/-(USD|USDT|USDC|BRL)$/, '')]);
  console.log(`::notice title=Preços::${comPx} ativos com histórico de preço, de ${tks.length}. Câmbio: ${globalThis._g20Cambio ? 'ok' : 'FALTOU'}. Sem preço: ${semPx.slice(0, 40).join(', ')}`);
  if (!Array.isArray(serie) || serie.length < 2) throw new Error('série vazia (' + (serie == null ? 'nula' : serie.length + ' dias') + ')');
  const D = serie.map(p => p.d), u = serie[serie.length - 1];
  const sem = (globalThis._g20SemCotacaoSerie || []);
  const twrMax = G.twrDesde(serie, D[0]);
  const resumo = `Série: ${serie.length} dias, de ${D[0]} a ${D[D.length - 1]}. Rentabilidade desde o início (TWR): ${twrMax == null ? '—' : twrMax.toFixed(2) + '%'}` + (sem.length ? `. Sem cotação hoje: ${sem.join(', ')}` : '');
  log(resumo); console.log('::notice title=Carteira G20::' + resumo);

  // resultado por ativo de cada período (o "Quem mais somou" dos alunos)
  const porAtivo = {};
  for (const p of Object.keys(PERIODOS)) {
    const a = inicioPer(D, p);
    try { porAtivo[p] = await G.porAtivo(D[a], D[D.length - 1]); } catch (e) { porAtivo[p] = null; }
  }

  const json = JSON.stringify(serie);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
  const sig = crypto.createHash('sha1').update(JSON.stringify([ent.sig || '', D[D.length - 1], serie.length])).digest('hex').slice(0, 16);
  const pa = JSON.stringify(porAtivo);
  const tam = `Comprimida: ${Math.round(gz.length / 1024)} KB (de ${Math.round(json.length / 1024)} KB). Por ativo: ${Math.round(pa.length / 1024)} KB.`;
  log(tam); console.log('::notice title=Tamanho::' + tam);
  if (gz.length + pa.length > 950000) throw new Error('documento grande demais para o Firestore');

  if (MODO === 'diagnostico') { log('Modo diagnóstico: nada gravado.'); return; }
  await dados.doc('cg20Rent').set({
    motor: 'g20rent', at: Date.now(), sig, entradaSig: ent.sig || '', n: serie.length,
    de: D[0], ate: D[D.length - 1], gz: true, d: gz, porAtivoJson: pa,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
  });
  log(`Gravado em users/{admin}/dados/cg20Rent em ${Math.round((Date.now() - t0) / 1000)} s.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); console.log('::error title=Falhou::' + String(e && e.message || e).slice(0, 300)); process.exit(1); });
