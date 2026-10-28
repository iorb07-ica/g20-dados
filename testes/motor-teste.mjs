// Teste do motor único (g20-rent.js) com carteiras inventadas cujo resultado se conhece de antemão.
import fs from 'node:fs'; import vm from 'node:vm';
const SRC = fs.readFileSync((process.env.MOTOR||new URL('../../plataforma-g20/assets/g20-rent.js', import.meta.url).pathname), 'utf8');
const hoje = new Date(); const iso = d => d.toISOString().slice(0, 10);
const dia = n => iso(new Date(Date.UTC(2026, 0, 5) + n * 864e5));   // dia 0 = 05/01/2026 (segunda)
let PX = {}, FX = {};   // PX[sym][iso] = preço ; FX[iso] = dólar
function yahooJSON(mapa) { const ds = Object.keys(mapa).sort(); return { chart: { result: [{ timestamp: ds.map(d => Date.parse(d + 'T15:00:00Z') / 1000), indicators: { quote: [{ close: ds.map(d => mapa[d]) }] } }] } }; }
function preparar() {
  const mem = {}; globalThis.window = globalThis;
  globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; }, key: i => Object.keys(mem)[i] || null, get length() { return Object.keys(mem).length; }, clear: () => { for (const k in mem) delete mem[k]; } };
  globalThis.G20Ind = { get: (k, d) => d };
  globalThis.fetch = async (u) => {
    u = String(u); const ok = j => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    let m = u.match(/symbol=([^&]+)/) || u.match(/chart\/([^?]+)/);
    if (m) { const s = decodeURIComponent(m[1]); if (s === 'USDBRL=X') return ok(yahooJSON(FX)); if (PX[s]) return ok(yahooJSON(PX[s])); return { ok: false, status: 404, json: async () => ({}) }; }
    if (/bcb\.gov\.br/.test(u)) return { ok: false, status: 500, json: async () => [] };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  delete globalThis.G20Rent; vm.runInThisContext(SRC, { filename: 'g20-rent.js' }); return globalThis.G20Rent;
}
function linear(a, b, n0, n1) { const o = {}; for (let n = n0; n <= n1; n++) { const d = new Date(Date.UTC(2026, 0, 5) + n * 864e5); if (d.getUTCDay() % 6 === 0) continue; o[dia(n)] = a + (b - a) * (n - n0) / (n1 - n0); } return o; }
const N = Math.floor((Date.now() - Date.UTC(2026, 0, 5)) / 864e5) - 1;
async function caso(nome, esperado, montar) {
  PX = {}; FX = linear(5, 5, 0, N); const ent = montar();
  const G = preparar(); localStorage.setItem('g20_rvAportes', JSON.stringify(ent.aportes)); localStorage.setItem('g20_rendaFixa', '[]');
  const serie = await G.calcular({ aportes: ent.aportes, proventos: ent.proventos || [], rendaFixa: [], _semGravar: true });
  const r = serie && serie.length ? G.twrDesde(serie, serie[0].d) : null;
  const rp = serie && serie.length ? G.retornoPeriodo(serie, 'max') : null;
  if (rp != null && r != null && Math.abs(rp - r) > 0.01) console.log('   ⚠ Dashboard (retornoPeriodo) dá ' + rp.toFixed(2) + '% e a curva ' + r.toFixed(2) + '%');
  if (process.env.VER && nome.startsWith(process.env.VER)) serie.forEach((p, i) => { if (i > 18 && i < 28) console.log(JSON.stringify(p).slice(0, 220)); });
  const okk = r != null && Math.abs(r - esperado) < 0.15;
  console.log((okk ? 'OK   ' : 'ERRO ') + nome + ': esperado ' + esperado.toFixed(2) + '% · motor ' + (r == null ? '—' : r.toFixed(2) + '%'));
  return okk;
}
const R = [];
// 1. Uma ação, preço de 10 para 11: +10%
R.push(await caso('Uma ação sobe 10%', 10, () => { PX['AAAA3.SA'] = Object.assign(linear(10, 11, 0, 40), linear(11, 11, 41, N)); return { aportes: [{ ticker: 'AAAA3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 100, preco: 10, moeda: 'BRL' }] }; }));
// 2. Aporte no meio: 10→12 (+20%), novo aporte a 12, depois 12→15 (+25%): 1,2 × 1,25 = +50% (o aporte não vira ganho)
R.push(await caso('Aporte no meio não conta como ganho', 50, () => { PX['BBBB3.SA'] = Object.assign(linear(10, 12, 0, 20), linear(12, 15, 21, 60), linear(15, 15, 61, N)); return { aportes: [{ ticker: 'BBBB3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 100, preco: 10, moeda: 'BRL' }, { ticker: 'BBBB3', tipo: 'Acao', op: 'C', data: dia(21), qtd: 500, preco: 12, moeda: 'BRL' }] }; }));
// 3. Provento: preço parado em 10, 100 ações, R$ 50 de provento: +5%
R.push(await caso('Provento de 5%', 5, () => { PX['CCCC11.SA'] = linear(10, 10, 0, N); return { aportes: [{ ticker: 'CCCC11', tipo: 'FII', op: 'C', data: dia(0), qtd: 100, preco: 10, moeda: 'BRL' }], proventos: [{ ticker: 'CCCC11', data: dia(30), total: 50, moeda: 'BRL', fonte: 'teste' }] }; }));
// 4. Ação americana parada em US$ 100, dólar de 5 para 5,5: +10% em reais
R.push(await caso('Dólar sobe 10% (ação dos EUA parada)', 10, () => { PX['XYZ'] = linear(100, 100, 0, N); const f = Object.assign(linear(5, 5.5, 0, 30), linear(5.5, 5.5, 31, N)); setTimeout(() => {}, 0); FX = f; return { aportes: [{ ticker: 'XYZ', tipo: 'Stock', op: 'C', data: dia(0), qtd: 10, preco: 100, moeda: 'USD', fxRate: 5 }] }; }));
// 5. Venda no meio: 10→12 (+20%), vende metade a 12, depois 12→9 (−25%): 1,2 × 0,75 = −10%
R.push(await caso('Venda no meio não muda a conta', -10, () => { PX['DDDD3.SA'] = Object.assign(linear(10, 12, 0, 20), linear(12, 9, 21, 60), linear(9, 9, 61, N)); return { aportes: [{ ticker: 'DDDD3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 10000, preco: 10, moeda: 'BRL' }, { ticker: 'DDDD3', tipo: 'Acao', op: 'V', data: dia(21), qtd: 5000, preco: 12, moeda: 'BRL' }] }; }));
// 6. Duas ações com pesos iguais: uma +20%, outra −10%: +5%
R.push(await caso('Duas ações (+20% e −10%)', 5, () => { PX['EEEE3.SA'] = Object.assign(linear(10, 12, 0, 30), linear(12, 12, 31, N)); PX['FFFF3.SA'] = Object.assign(linear(20, 18, 0, 30), linear(18, 18, 31, N)); return { aportes: [{ ticker: 'EEEE3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 100, preco: 10, moeda: 'BRL' }, { ticker: 'FFFF3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 50, preco: 20, moeda: 'BRL' }] }; }));
// 7. Compra acima do preço do dia (corretagem/erro de 2%): perde 2% no dia da compra, depois +10%
R.push(await caso('Compra 2% acima do mercado (conta a partir do fechamento do 1º dia)', 10, () => { PX['GGGG3.SA'] = Object.assign(linear(10, 11, 0, 40), linear(11, 11, 41, N)); return { aportes: [{ ticker: 'GGGG3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 100, preco: 10.2, moeda: 'BRL' }] }; }));
// 8. Ativo sem preço por 10 dias no meio (buraco no histórico): as duas contas têm de dar o mesmo
R.push(await caso('Buraco de 10 dias no preço de um ativo', 5, () => { const h = Object.assign(linear(10, 12, 0, 30), linear(12, 12, 31, N)); for (let n = 12; n < 22; n++) delete h[dia(n)]; PX['HHHH3.SA'] = h; PX['IIII3.SA'] = Object.assign(linear(20, 18, 0, 30), linear(18, 18, 31, N)); return { aportes: [{ ticker: 'HHHH3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 1000, preco: 10, moeda: 'BRL' }, { ticker: 'IIII3', tipo: 'Acao', op: 'C', data: dia(0), qtd: 500, preco: 20, moeda: 'BRL' }] }; }));
console.log(R.every(Boolean) ? '\nTODOS OS TESTES PASSARAM' : '\nHÁ TESTE COM ERRO');
