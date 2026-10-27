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
  // e o nosso proxy (g20-proxy) só atende pedidos que vêm do site: o robô se identifica como o site
  globalThis.fetch = (u, o = {}) => {
    o = Object.assign({}, o);
    const h = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/json,text/plain,*/*' };
    if (/g20-proxy/.test(String(u))) { h.Origin = 'https://g20hub.com'; h.Referer = 'https://g20hub.com/carteira.html'; }
    o.headers = Object.assign(h, o.headers || {});
    return _f(u, o);
  };
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
  try { const t = await fetch('https://g20-proxy.vercel.app/api/history?symbol=PETR4.SA&range=1mo&interval=1d'); const tx = await t.text();
    console.log(`::notice title=Teste do proxy::HTTP ${t.status} · ${tx.slice(0, 160).replace(/\s+/g, ' ')}`); } catch (e) { console.log('::notice title=Teste do proxy::erro ' + e.message); }
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

  if (MODO === 'diagnostico') {
    // ano a ano (só %), para comparar com a página
    const anos = [...new Set(D.map(d => d.slice(0, 4)))];
    const linhas = anos.map(y => { const ini = D.filter(d => d < y + '-01-01').pop() || D[0]; const sub = serie.filter(p => p.d <= y + '-12-31'); const r = G.twrDesde(sub, ini); return y + ': ' + (r == null ? '—' : (r >= 0 ? '+' : '') + r.toFixed(2) + '%'); });
    console.log('::notice title=Ano a ano (TWR)::' + linhas.join(' · '));
    try { const dc = G.decompor(serie, D[0], D[D.length - 1]); if (dc) { const tot = Math.abs(dc.ativos) + Math.abs(dc.cambio) + Math.abs(dc.proventos) + Math.abs(dc.rendaFixa || 0) || 1;
      console.log(`::notice title=De onde veio (proporção do resultado)::ativos ${(dc.ativos / tot * 100).toFixed(1)}% · câmbio ${(dc.cambio / tot * 100).toFixed(1)}% · proventos ${(dc.proventos / tot * 100).toFixed(1)}%`); } } catch (e) {}
    try { const tir = G.tir(serie, D[0], D[D.length - 1]); console.log('::notice title=TIR ao ano::' + (tir == null ? '—' : (tir * (Math.abs(tir) < 1 ? 100 : 1)).toFixed(2) + '%')); } catch (e) {}
  }
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

  if (MODO === 'diagnostico') {
    // 28/10/2026: a MESMA série diária, mas medida mês a mês (como o motor mensal da página faz),
    // para ver se a diferença é de método (data dos aportes dentro do mês) ou de dados
    try {
      const meses = {}; serie.forEach((p, i) => { const m = p.d.slice(0, 7); (meses[m] = meses[m] || []).push(i); });
      const ks = Object.keys(meses).sort(); let fIni = 1, fFim = 1, fDz = 1, prevFim = null;
      ks.forEach(m => { const idx = meses[m], a = idx[0] > 0 ? idx[0] - 1 : idx[0], b = idx[idx.length - 1];
        const V0 = serie[a].patrimonio, V1 = serie[b].patrimonio; let F = 0, Fw = 0, P = 0; const dias = b - a || 1;
        for (let i = a + 1; i <= b; i++){ const f = serie[i].fluxo || 0; F += f; Fw += f * (b - i) / dias; P += (serie[i].prov || 0); }
        if (V0 + F > 0){ fIni *= (V1 + P) / (V0 + F); }            // aporte no começo do mês
        if (V0 > 0){ fFim *= (V1 + P - F) / V0; }                   // aporte no fim do mês
        if (V0 + Fw > 0){ fDz *= 1 + (V1 + P - V0 - F) / (V0 + Fw); } // Dietz modificado
      });
      console.log(`::notice title=Mesma série medida mês a mês::aporte no começo do mês ${((fIni - 1) * 100).toFixed(1)}% · no fim do mês ${((fFim - 1) * 100).toFixed(1)}% · Dietz ${((fDz - 1) * 100).toFixed(1)}% (diário: ${twrMax == null ? '—' : twrMax.toFixed(1)}%)`);
      const p0 = serie.slice(0, 200).map(p => p.d.slice(5) + ' ' + Math.round(p.patrimonio)).filter((_, i) => i % 20 === 0);
      console.log('::notice title=Tamanho da carteira no começo (a cada 20 dias)::' + serie.slice(0, 400).filter((_, i) => i % 25 === 0).map(p => p.d + ' ' + (p.patrimonio < 1000 ? 'menos de mil' : p.patrimonio < 10000 ? 'poucos mil' : p.patrimonio < 50000 ? 'dezenas de mil' : 'acima de 50 mil')).join(' · '));
    } catch (e) { console.log('::notice title=Mês a mês::erro ' + e.message); }
    // 28/10/2026: período de ago/19 a out/21, onde a página e o robô se separam
    try {
      const fimJan = D.filter(d => d <= '2021-10-31').pop();
      const r1921 = G.twrDesde(serie.filter(p => p.d <= fimJan), D[0]);
      const lst = await G.porAtivo(D[0], fimJan) || [];
      const px = globalThis._g20Precos || {};
      const tipoDe = {}, moedas = {}; ent.aportes.forEach(x => { const t = String(x.ticker).toUpperCase(); tipoDe[t] = x.tipo; if (x.data <= '2021-10-31') (moedas[t] = moedas[t] || new Set()).add(String(x.moeda || '(vazio)')); });
      const desc = l => { const base = (l.aportes || 0) + (l.valorInicio || 0); const pct = base > 0 ? (l.resultado / base * 100) : null; const p0 = px[l.ticker] && px[l.ticker].primeiro ? px[l.ticker].primeiro : ''; return `${l.ticker} [${tipoDe[l.ticker] || '?'}; moeda ${[...(moedas[l.ticker] || [])].join('/') || '-'}] ${pct == null ? '' : (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%'}${p0 ? ' preço desde ' + p0 : ''}`; };
      const ord = lst.slice().sort((x, y) => x.resultado - y.resultado);
      console.log(`::notice title=Ago/19 a out/21::TWR ${r1921 == null ? '—' : r1921.toFixed(2) + '%'} · ativos com resultado: ${lst.length}`);
      console.log('::notice title=Ago/19 a out/21 · piores::' + ord.slice(0, 12).map(desc).join(' | '));
      console.log('::notice title=Ago/19 a out/21 · melhores::' + ord.slice(-12).reverse().map(desc).join(' | '));
      // moedas usadas nos lançamentos de ativos de fora, até out/21
      const fora = Object.keys(moedas).filter(t => ['Stock', 'REIT', 'ETF', 'UCITs', 'Cripto'].includes(tipoDe[t]));
      const brl = fora.filter(t => moedas[t].has('BRL'));
      console.log('::notice title=Moeda dos lançamentos de fora até out/21::' + fora.length + ' ativos; marcados como BRL: ' + (brl.join(', ') || 'nenhum'));
      // série: dias com patrimônio muito diferente do dia anterior (saltos) até out/21
      const saltos = []; for (let i = 1; i < serie.length && serie[i].d <= fimJan; i++) { const a0 = serie[i - 1].patrimonio, a1 = serie[i].patrimonio - (serie[i].fluxo || 0); if (a0 > 0 && Math.abs(a1 / a0 - 1) > 0.08) saltos.push(serie[i].d + ' ' + ((a1 / a0 - 1) * 100).toFixed(1) + '%'); }
      console.log('::notice title=Saltos diários acima de 8% até out/21::' + (saltos.slice(0, 25).join(' · ') || 'nenhum'));
    } catch (e) { console.log('::notice title=Ago/19 a out/21::erro ' + e.message); }
    const L = (porAtivo.max || []).slice().sort((x, y) => x.resultado - y.resultado);
    console.log('::notice title=Quem mais tirou (desde o início)::' + L.slice(0, 8).map(x => x.ticker).join(', ') + ' · quem mais somou: ' + L.slice(-8).reverse().map(x => x.ticker).join(', '));
    log('Modo diagnóstico: nada gravado.'); return; }
  await dados.doc('cg20Rent').set({
    motor: 'g20rent', at: Date.now(), sig, entradaSig: ent.sig || '', n: serie.length,
    de: D[0], ate: D[D.length - 1], gz: true, d: gz, porAtivoJson: pa,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
  });
  log(`Gravado em users/{admin}/dados/cg20Rent em ${Math.round((Date.now() - t0) / 1000)} s.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); console.log('::error title=Falhou::' + String(e && e.message || e).slice(0, 300)); process.exit(1); });
