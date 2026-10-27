// Setores dos ativos para a Plataforma G20 (out/2026)
//
// Grava dados/setores.json com o setor de cada ativo, numa classificação única para Brasil e
// exterior, usada pela aba Gráficos (subaba Composição) da Minha Carteira e da Carteira G20.
// Roda pela tarefa .github/workflows/setores.yml, uma vez por semana.
//
// Fontes (gratuitas, sem chave):
//   Ações do Brasil: B3 Empresas Listadas (classificação setorial oficial: setor / subsetor / segmento).
//   FIIs, Fiagros e FI-Infra: lista de fundos que já têm base de proventos (dados/proventos/br) e as
//     listas de assets/b3-classificacao.js; o segmento vem do detalhe do fundo na B3, quando existe.
//   Exterior: SEC (EUA), código SIC de cada empresa, convertido para a classificação única.
// Universo do exterior: scripts/tickers-source.js (Carteira G20 + S&P 500) + dados/setores-extra.txt
//   (um ticker por linha; o Israel pode acrescentar ativos que faltarem).
//
// Modos (variável MODO):
//   atualizar   = rotina semanal: só ativos novos ou com setor guardado há mais de 180 dias
//   completo    = refaz todos
//   diagnostico = não grava nada; mostra no log o que as fontes devolvem para TICKERS (ou uma amostra)
// TICKERS (opcional) restringe a lista.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAIDA = path.join(RAIZ, 'dados', 'setores.json');
const MODO = (process.env.MODO || 'atualizar').trim();
const TICKERS = (process.env.TICKERS || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
const LIMITE_MS = (parseFloat(process.env.HORAS || '1') || 1) * 3600 * 1000;
const INICIO = Date.now();
const HOJE = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);   // Brasília
const VELHO_DIAS = 180;

const B3 = 'https://sistemaswebb3-listados.b3.com.br/';
const HB = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json, text/plain, */*', Referer: 'https://www.b3.com.br/', Origin: 'https://www.b3.com.br' };
const HSEC = { 'User-Agent': 'G20 Hub contato@g20hub.com', Accept: 'application/json' };   // a SEC exige identificação

const espera = ms => new Promise(r => setTimeout(r, ms));
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
const tempoAcabou = () => Date.now() - INICIO > LIMITE_MS;
const log = (...a) => console.log(...a);

async function pedir(url, { headers = {}, pausa = 400, tentativas = 3 } = {}) {
  await espera(pausa);
  let ultimo;
  for (let t = 0; t < tentativas; t++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      const txt = await r.text();
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!txt.trim()) return null;
      let d = JSON.parse(txt);
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
      return d;
    } catch (e) { ultimo = e; await espera(2500 * (t + 1)); }
  }
  throw ultimo;
}
const b3 = (rota, params) => pedir(B3 + rota + '/' + b64(params), { headers: HB });

// ── classificação única (Brasil + exterior) ───────────────────────────────
const SETORES = ['Tecnologia', 'Financeiro', 'Saúde', 'Consumo cíclico', 'Consumo não cíclico', 'Indústria', 'Energia',
  'Materiais', 'Utilidades', 'Comunicação', 'Imobiliário', 'Agronegócio', 'Infraestrutura', 'Outros'];

// setor da B3 → classificação única (alguns subsetores mudam de grupo)
function deB3(setor, sub, seg) {
  const S = String(setor || '').toLowerCase(), U = String(sub || '').toLowerCase(), G = String(seg || '').toLowerCase();
  if (/imóve|imove/.test(U) || /imóve|imove/.test(G)) return 'Imobiliário';
  if (/petróleo|petroleo/.test(S)) return 'Energia';
  if (/construção e transporte|construcao e transporte/.test(S)) return /constru/.test(U) ? 'Consumo cíclico' : 'Indústria';   // nome antigo da B3
  if (/materiais/.test(S)) return 'Materiais';
  if (/bens industriais/.test(S)) return 'Indústria';
  if (/não cíclico|nao ciclico/.test(S)) return 'Consumo não cíclico';
  if (/cíclico|ciclico/.test(S)) return 'Consumo cíclico';
  if (/saúde|saude/.test(S)) return 'Saúde';
  if (/tecnologia/.test(S)) return 'Tecnologia';
  if (/comunica/.test(S)) return 'Comunicação';
  if (/utilidade/.test(S)) return 'Utilidades';
  if (/financeiro/.test(S)) return 'Financeiro';
  return 'Outros';
}

// código SIC da SEC → classificação única
function deSic(sic) {
  const n = parseInt(sic, 10); if (!isFinite(n)) return null;
  const e = (a, b) => n >= a && n <= b;
  if (e(1311, 1389) || e(2900, 2999)) return 'Energia';
  if (e(100, 999) || e(2000, 2199)) return 'Consumo não cíclico';
  if (e(1000, 1499)) return 'Materiais';
  if (e(1500, 1799)) return 'Indústria';
  if (e(2200, 2399) || e(2500, 2599)) return 'Consumo cíclico';
  if (e(2400, 2499) || e(2600, 2699) || e(2800, 2829) || e(2850, 2899) || e(3000, 3399)) return 'Materiais';
  if (e(2700, 2799)) return 'Comunicação';
  if (e(2830, 2836)) return 'Saúde';
  if (e(2840, 2844)) return 'Consumo não cíclico';
  if (e(3570, 3579) || e(3600, 3629) || e(3640, 3699)) return 'Tecnologia';
  if (e(3630, 3639)) return 'Consumo cíclico';
  if (e(3400, 3569) || e(3580, 3599)) return 'Indústria';
  if (e(3710, 3716) || e(3750, 3799)) return 'Consumo cíclico';
  if (e(3700, 3799)) return 'Indústria';
  if (e(3841, 3851)) return 'Saúde';
  if (e(3800, 3899)) return 'Tecnologia';
  if (e(3900, 3999)) return 'Consumo cíclico';
  if (e(4000, 4799)) return 'Indústria';
  if (e(4800, 4899)) return 'Comunicação';
  if (e(4900, 4999)) return 'Utilidades';
  if (n === 5122 || n === 5912) return n === 5122 ? 'Saúde' : 'Consumo não cíclico';
  if (e(5400, 5499)) return 'Consumo não cíclico';
  if (e(5000, 5199)) return 'Indústria';
  if (e(5200, 5999)) return 'Consumo cíclico';
  if (n === 6798 || e(6500, 6553)) return 'Imobiliário';
  if (e(6000, 6799)) return 'Financeiro';
  if (e(7370, 7379)) return 'Tecnologia';
  if (e(7000, 7099) || e(7200, 7299)) return 'Consumo cíclico';
  if (e(7800, 7999)) return 'Comunicação';
  if (e(8000, 8099)) return 'Saúde';
  if (e(7300, 7399) || e(8700, 8799)) return 'Indústria';
  return 'Outros';
}
// casos em que o SIC engana (ex.: Visa aparece como "serviços"; Alphabet e Meta como software)
const AJUSTE_EUA = { GOOGL: 'Comunicação', GOOG: 'Comunicação', META: 'Comunicação', NFLX: 'Comunicação', DIS: 'Comunicação',
  V: 'Financeiro', MA: 'Financeiro', PYPL: 'Financeiro', FI: 'Financeiro', FIS: 'Financeiro', GPN: 'Financeiro', XYZ: 'Financeiro',
  AMZN: 'Consumo cíclico', TSLA: 'Consumo cíclico', UBER: 'Indústria', BKNG: 'Consumo cíclico', ABNB: 'Consumo cíclico',
  MELI: 'Consumo cíclico', SE: 'Consumo cíclico', BABA: 'Consumo cíclico', SHOP: 'Tecnologia', SPOT: 'Comunicação',
  ASML: 'Tecnologia', AMAT: 'Tecnologia', LRCX: 'Tecnologia', KLAC: 'Tecnologia', TER: 'Tecnologia' };   // equipamentos de chip (SIC 3559) são tecnologia
const limpaB3 = s => String(s || '').replace(/ \. /g, ', ').replace(/\. /g, ', ').trim();   // a B3 devolve "Petróleo. Gás" no lugar de "Petróleo, Gás"

// ── universo ─────────────────────────────────────────────────────────────
function listaJs(nome) {
  try { const t = fs.readFileSync(path.join(RAIZ, 'scripts', 'b3-classificacao.js'), 'utf8'); const m = t.match(new RegExp('var ' + nome + '\\s*=\\s*\\[([\\s\\S]*?)\\];'));
    return m ? (m[1].match(/'([A-Z0-9]+)'/g) || []).map(s => s.replace(/'/g, '')) : []; } catch { return []; }
}
function universoExterior() {
  const out = new Set();
  try { const req = createRequire(import.meta.url); (req(path.join(RAIZ, 'scripts', 'tickers-source.js')) || []).forEach(t => { const s = String(t).toUpperCase().replace(/\.SA$/, '').trim(); if (s && !/\d/.test(s)) out.add(s); }); } catch (e) { log('AVISO tickers-source.js:', e.message); }
  try { fs.readFileSync(path.join(RAIZ, 'dados', 'setores-extra.txt'), 'utf8').split(/\r?\n/).forEach(l => { const s = l.replace(/#.*/, '').trim().toUpperCase(); if (s && !/\d$/.test(s)) out.add(s); }); } catch {}
  return [...out];
}
function universoFundos() {
  const units = new Set(listaJs('UNITS_CONHECIDAS')), etfs = new Set(listaJs('ETFS_B3_CONHECIDOS'));
  const fiagro = new Set(listaJs('FIAGROS_CONHECIDOS')), infra = new Set(listaJs('FIINFRAS_CONHECIDOS'));
  let arqs = []; try { arqs = fs.readdirSync(path.join(RAIZ, 'dados', 'proventos', 'br')); } catch {}
  const out = [];
  arqs.map(a => a.replace(/\.json$/, '')).filter(t => /^[A-Z]{4}11$/.test(t) && !units.has(t) && !etfs.has(t))
    .forEach(t => out.push({ t, tipo: fiagro.has(t) ? 'fiagro' : (infra.has(t) ? 'infra' : 'fii') }));
  return { fundos: out, etfs: [...etfs] };
}
async function listarEmpresas() {
  const out = new Map(); let p = 1, tot = 1;
  while (p <= tot && p <= 60) {
    const d = await b3('listedCompaniesProxy/CompanyCall/GetInitialCompanies', { language: 'pt-br', pageNumber: p, pageSize: 120 });
    for (const e of d?.results || []) if (e.issuingCompany) out.set(String(e.issuingCompany).toUpperCase(), e);
    tot = d?.page?.totalPages || 1; p++;
  }
  const ACOES_MERCADO = ['NM', 'N1', 'N2', 'MA', 'M2', 'MB', 'CMP'];
  return [...out.values()].filter(e => String(e.type) === '1' || ACOES_MERCADO.includes(String(e.market || '').toUpperCase()));
}

// ── consultas ────────────────────────────────────────────────────────────
async function setorEmpresaB3(e) {
  const d = await b3('listedCompaniesProxy/CompanyCall/GetDetail', { codeCVM: String(e.codeCVM), language: 'pt-br' });
  const o = Array.isArray(d) ? d[0] : d;
  const cl = String(o?.industryClassification || '').split('/').map(s => s.trim());
  if (!cl[0]) return null;
  return { s: deB3(cl[0], cl[1], cl[2]), setorB3: limpaB3(cl[0]), sub: limpaB3(cl[1]), seg: limpaB3(cl[2]), nome: o?.tradingName || e.tradingName || '', f: 'b3', em: HOJE };
}
async function segmentoFundo(sigla) {
  try {
    const d = await b3('fundsProxy/fundsCall/GetDetailFundSIG', { typeFund: 7, cnpj: '0', identifierFund: sigla });
    const f = d?.detailFund || d || {};
    const seg = f.segment || f.segmento || f.classification || f.classificacao || f.mandate || '';
    return { seg: String(seg || '').trim(), nome: f.tradingName || f.fundName || '' };
  } catch { return { seg: '', nome: '' }; }
}
let _secMapa = null;
async function mapaSec() {
  if (_secMapa) return _secMapa;
  const d = await pedir('https://www.sec.gov/files/company_tickers.json', { headers: HSEC, pausa: 200 });
  _secMapa = {}; Object.values(d || {}).forEach(x => { if (x && x.ticker) _secMapa[String(x.ticker).toUpperCase()] = { cik: x.cik_str, nome: x.title }; });
  return _secMapa;
}
async function setorEua(t) {
  const m = await mapaSec(), k = m[t] || m[t.replace('.', '-')] || m[t.replace('-', '.')];
  if (!k) return null;
  const d = await pedir('https://data.sec.gov/submissions/CIK' + String(k.cik).padStart(10, '0') + '.json', { headers: HSEC, pausa: 150 });
  if (!d) return null;
  const sic = d.sic || '', desc = d.sicDescription || '';
  let s = AJUSTE_EUA[t] || deSic(sic);
  if (!sic && /etf|fund|trust/i.test(d.name || k.nome || '')) s = 'Diversificado';
  return { s: s || 'Outros', sic: String(sic), sub: desc, nome: d.name || k.nome || '', f: 'sec', em: HOJE };
}

// ── principal ────────────────────────────────────────────────────────────
const velho = (x) => !x || !x.em || (Date.parse(HOJE) - Date.parse(x.em)) / 864e5 > VELHO_DIAS || MODO === 'completo';
async function main() {
  let base = { ativos: {} };
  try { base = JSON.parse(fs.readFileSync(SAIDA, 'utf8')); } catch {}
  const A = base.ativos || {};
  const quer = t => !TICKERS.length || TICKERS.includes(t);

  if (MODO === 'diagnostico') {
    const amostra = TICKERS.length ? TICKERS : ['PETR4', 'ITUB4', 'WEGE3', 'HGLG11', 'KNCA11', 'AAPL', 'GOOGL', 'V', 'O'];
    const emp = await listarEmpresas();
    log('Empresas com ações na B3:', emp.length, '| campos:', emp[0] ? Object.keys(emp[0]).join(', ') : '-');
    for (const t of amostra) {
      if (/^[A-Z]{4}11$/.test(t)) { const d = await b3('fundsProxy/fundsCall/GetDetailFundSIG', { typeFund: 7, cnpj: '0', identifierFund: t.slice(0, 4) }).catch(e => ({ erro: e.message })); log('\n[' + t + '] fundo B3:', JSON.stringify(d).slice(0, 1500)); }
      if (/\d$/.test(t)) { const e = emp.find(x => String(x.issuingCompany).toUpperCase() === t.replace(/\d+$/, '')); if (!e) { log('\n[' + t + '] empresa não achada na lista da B3'); continue; }
        const d = await b3('listedCompaniesProxy/CompanyCall/GetDetail', { codeCVM: String(e.codeCVM), language: 'pt-br' }).catch(x => ({ erro: x.message })); log('\n[' + t + '] detalhe B3:', JSON.stringify(d).slice(0, 1200), '\n→', JSON.stringify(await setorEmpresaB3(e).catch(x => x.message))); }
      else { log('\n[' + t + '] SEC →', JSON.stringify(await setorEua(t).catch(x => x.message))); }
    }
    return;
  }

  let novos = 0, erros = 0;
  // 1) ações do Brasil, pela raiz do código (PETR para PETR3 e PETR4)
  try {
    const emp = await listarEmpresas();
    log('Empresas com ações na B3:', emp.length);
    for (const e of emp) {
      if (tempoAcabou()) break;
      const raiz = String(e.issuingCompany).toUpperCase();
      if (TICKERS.length && !TICKERS.some(t => t.replace(/\d+$/, '') === raiz)) continue;
      if (!velho(A[raiz])) continue;
      try { const r = await setorEmpresaB3(e); if (r) { A[raiz] = r; novos++; } } catch (x) { erros++; log('AVISO', raiz, x.message); }
    }
  } catch (x) { log('AVISO lista da B3:', x.message); }
  // 2) fundos imobiliários, Fiagros e FI-Infra (pelo código completo)
  const { fundos, etfs } = universoFundos();
  for (const f of fundos) {
    if (tempoAcabou()) break;
    if (!quer(f.t) || !velho(A[f.t])) continue;
    const s = f.tipo === 'fiagro' ? 'Agronegócio' : (f.tipo === 'infra' ? 'Infraestrutura' : 'Imobiliário');
    const d = await segmentoFundo(f.t.slice(0, 4));
    A[f.t] = { s, sub: d.seg || (f.tipo === 'fii' ? 'Fundo imobiliário' : f.tipo === 'fiagro' ? 'Fiagro' : 'FI-Infra'), nome: d.nome || '', f: 'b3-fundo', em: HOJE }; novos++;
  }
  // 3) ETFs da B3: carteira de vários setores
  etfs.forEach(t => { if (quer(t) && velho(A[t])) { A[t] = { s: 'Diversificado', sub: 'ETF', f: 'lista', em: HOJE }; novos++; } });
  // 4) exterior (SEC)
  for (const t of universoExterior()) {
    if (tempoAcabou()) break;
    if (!quer(t) || !velho(A[t])) continue;
    try { const r = await setorEua(t); if (r) { A[t] = r; novos++; } } catch (x) { erros++; log('AVISO', t, x.message); }
  }

  // reaplica a classificação a tudo que está guardado (sem rede): ajuste nas regras vale para todos na hora
  let refeitos = 0;
  Object.keys(A).forEach(k => { const x = A[k]; if (!x) return; let s = x.s;
    if (x.f === 'b3') { x.setorB3 = limpaB3(x.setorB3); x.sub = limpaB3(x.sub); x.seg = limpaB3(x.seg); s = deB3(x.setorB3, x.sub, x.seg); }
    else if (x.f === 'sec' && x.sic) s = AJUSTE_EUA[k] || deSic(x.sic);
    else if (x.f === 'sec' && AJUSTE_EUA[k]) s = AJUSTE_EUA[k];
    if (s !== x.s) { x.s = s; refeitos++; } });
  if (refeitos) log('Reclassificados pelas regras atuais:', refeitos);
  const ord = {}; Object.keys(A).sort().forEach(k => { ord[k] = A[k]; });
  const saida = { atualizado: new Date().toISOString(), versao: 1, setores: SETORES.concat(['Diversificado']),
    nota: 'Ações do Brasil pela raiz do código (PETR vale para PETR3 e PETR4); fundos e exterior pelo código completo.', ativos: ord };
  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  fs.writeFileSync(SAIDA, JSON.stringify(saida) + '\n');
  log(`Setores: ${Object.keys(ord).length} ativos no arquivo, ${novos} novos ou atualizados, ${erros} erros.` + (tempoAcabou() ? ' Parou no limite de tempo; rodar de novo continua.' : ''));
}
main().catch(e => { console.error(e); process.exit(1); });
