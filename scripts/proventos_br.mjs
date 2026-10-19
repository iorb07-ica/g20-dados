// Base de proventos do Brasil para a Plataforma G20 (out/2026)
//
// Grava em dados/proventos/br/ um arquivo por ativo (PETR4.json, HGLG11.json...) e o
// índice indice.json. Roda pela tarefa .github/workflows/proventos-br.yml.
//
// Fontes (todas validadas nos testes de 16/10/2026):
//   Ações: B3 Empresas Listadas = base (valor por ação da época, tipo, data com,
//          correção pela Selic, lote de mil, desdobramentos, grupamentos, bonificações)
//          + B3 recente (data de pagamento oficial dos últimos ~12 meses)
//          + brapi (data de pagamento dos anos anteriores, com parcelas). Sem chave da
//          brapi só PETR4, VALE3, MGLU3 e ITUB4 têm data de pagamento antiga.
//   FIIs:  FundosNET (avisos estruturados de rendimentos e amortizações, desde ~2016)
//          + B3 recente (últimos ~12 meses, com data de pagamento oficial).
// Quando nenhuma fonte tem a data de pagamento, ela fica vazia e pagEstimado = true
// (a plataforma usa a data com no lugar e mostra "data estimada").
//
// Modos (variável MODO): teste | acoes | fiis | diagnostico. TICKERS (opcional) restringe a lista.
// diagnostico (out/2026): não grava nada. Para cada ativo de TICKERS mostra no log o que as fontes
//   devolvem: FIIs = cada aviso do FundosNET (situação, datas, código e todos os campos de cada
//   rendimento); ações = se a empresa é achada (listada ou cancelada) e o histórico da B3.
// Para no limite de tempo (HORAS) e grava o que fez; rodar de novo continua de onde parou.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAIDA = path.join(RAIZ, 'dados', 'proventos', 'br');
const MODO = (process.env.MODO || 'teste').trim();
const TICKERS = (process.env.TICKERS || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
const TOKEN = (process.env.BRAPI_TOKEN || '').trim();
const LIMITE_MS = (parseFloat(process.env.HORAS || '5.3') || 5.3) * 3600 * 1000;
const INICIO = Date.now();
const HOJE = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // Brasília
const BRAPI_GRATIS = ['PETR4', 'VALE3', 'MGLU3', 'ITUB4'];
const CNPJ_TESTE = { HGLG11: '11728688000147', MXRF11: '97521225000125', KNRI11: '12005956000165' };
// teste também com Fiagros e FI-Infra (CNPJ descoberto pela própria carga)
const FUNDOS_TESTE = ['HGLG11', 'MXRF11', 'KNRI11', 'RZAG11', 'KNCA11', 'KDIF11', 'CPTI11', 'BCFF11'];

const B3 = 'https://sistemaswebb3-listados.b3.com.br/';
const HB = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json, text/plain, */*', Referer: 'https://www.b3.com.br/', Origin: 'https://www.b3.com.br' };
const FN = 'https://fnet.bmfbovespa.com.br/fnet/publico/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const espera = ms => new Promise(r => setTimeout(r, ms));
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
const tempoAcabou = () => Date.now() - INICIO > LIMITE_MS;
const relatorio = { modo: MODO, inicio: new Date().toISOString(), gravados: [], erros: [], avisos: [], amostras: [] };
const aviso = s => { relatorio.avisos.push(s); console.log('AVISO', s); };

// ── utilidades ───────────────────────────────────────────────────────────
async function pedir(url, { headers = {}, json = true, pausa = 1100, tentativas = 3 } = {}) {
  await espera(pausa);
  let ultimo;
  for (let t = 0; t < tentativas; t++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      const txt = await r.text();
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!json) return txt;
      if (!txt.trim()) return null;
      let d = JSON.parse(txt);
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
      return d;
    } catch (e) { ultimo = e; await espera(2500 * (t + 1)); }
  }
  throw ultimo;
}
const b3 = (rota, params) => pedir(B3 + rota + '/' + b64(params), { headers: HB });
const iso = s => { const v = String(s || '').trim(); let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; m = v.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const num = v => { if (typeof v === 'number') return v; const s = String(v ?? '').trim(); if (!s) return 0; return parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0; };
const tipoDe = s => { const u = String(s || '').toUpperCase(); if (/JCP|JRS|JUROS/.test(u)) return 'JCP'; if (/AMORT/.test(u)) return 'AMORT'; if (/REND/.test(u)) return 'REND'; if (/DIV/.test(u)) return 'DIV'; return u.trim() || '?'; };
const CLASSE_DIGITO = { ON: '3', PN: '4', PNA: '5', PNB: '6', PNC: '7', PND: '8', UNT: '11' };
const classeNorm = s => { const u = String(s || '').toUpperCase().trim().split(/\s+/)[0]; return u === 'UNIT' ? 'UNT' : u; };
// classe de uma ação pelo ISIN. Só vale o ISIN principal (ACN = ações, CDA = units); séries antigas,
// recibos e direitos (A04, N01, R14...) ficam de fora para não duplicar eventos nem proventos.
const classeIsin = isin => { const s = String(isin || '').toUpperCase(); if (s.length < 11) return ''; const serie = s.slice(6, 9); if (serie === 'CDA' || serie === 'UNT') return 'UNT'; if (serie !== 'ACN') return ''; return { OR: 'ON', PR: 'PN', PA: 'PNA', PB: 'PNB', PC: 'PNC', PD: 'PND' }[s.slice(9, 11)] || ''; };
const r8 = v => +(+v).toFixed(10);
const ordenar = arr => arr.sort((a, b) => (b.dataCom || '').localeCompare(a.dataCom || '') || (b.dataPag || '').localeCompare(a.dataPag || ''));
function gravar(ticker, obj) {
  fs.mkdirSync(SAIDA, { recursive: true });
  fs.writeFileSync(path.join(SAIDA, ticker + '.json'), JSON.stringify(obj));
  relatorio.gravados.push(ticker);
}
function multiplicador(label, fator) {
  const u = String(label || '').toUpperCase(), f = num(fator);
  if (!f) return null;
  if (u.includes('GRUPAMENTO')) return r8(f);
  if (u.includes('DESDOBRAMENTO') || u.includes('BONIFICA')) return r8(1 + f / 100);
  return null;
}
function eventosDe(lista, filtro) {
  const vistos = new Set(), out = [];
  for (const e of lista || []) {
    if (filtro && !filtro(e)) continue;
    const ev = { tipo: String(e.label || '').trim(), dataCom: iso(e.lastDatePrior), aprovado: iso(e.approvedOn), fator: num(e.factor), multiplicador: multiplicador(e.label, e.factor), isin: e.isinCode || '', isinEmitido: e.assetIssued || '' };
    if (e.remarks) ev.obs = String(e.remarks).trim().slice(0, 300);
    const k = [ev.tipo, ev.dataCom, ev.fator, ev.isinEmitido].join('|');
    if (vistos.has(k)) continue;
    vistos.add(k); out.push(ev);
  }
  return ordenar(out);
}
// Atribui a data de pagamento a um grupo de proventos da B3 (mesma data com e tipo),
// usando os candidatos de outra fonte (cada um com data e valor). Empresas que pagam em
// parcelas aparecem com vários candidatos: primeiro casa valor com valor; o que sobrar e
// corresponder à soma das parcelas é dividido entre elas, mantendo o total da B3.
function atribuir(grupo, cands) {
  const comData = cands.filter(c => c.pag);
  const datas = [...new Set(comData.map(c => c.pag))].sort();
  if (!comData.length) return null;
  if (datas.length === 1) return grupo.map(b => [{ ...b, dataPag: datas[0] }]).flat();
  const perto = (x, y) => Math.abs(x - y) <= Math.max(1e-7, Math.abs(y) * 0.01);
  const usados = new Set(), out = [], sobra = [];
  for (const b of grupo) {
    const i = comData.findIndex((c, k) => !usados.has(k) && perto(c.v, b.valor));
    if (i >= 0) { usados.add(i); out.push({ ...b, dataPag: comData[i].pag }); } else sobra.push(b);
  }
  const resto = comData.filter((c, k) => !usados.has(k));
  for (const b of sobra) {
    const base = resto.length ? resto : comData;
    const porData = new Map();
    base.forEach(c => porData.set(c.pag, (porData.get(c.pag) || 0) + (c.v || 0)));
    const soma = [...porData.values()].reduce((x, y) => x + y, 0);
    if (porData.size > 1 && (b.tipo === 'REND' || perto(soma, b.valor) || b.tipo !== (base[0].t || b.tipo))) {
      [...porData.entries()].sort((x, y) => x[0].localeCompare(y[0])).forEach(([pag, v], i) => out.push({ ...b, valor: r8(soma > 0 ? b.valor * v / soma : b.valor / porData.size), dataPag: pag, parcela: i + 1 }));
    } else {
      const c = base.reduce((m, c) => (Math.abs(c.v - b.valor) < Math.abs(m.v - b.valor) ? c : m), base[0]);
      out.push({ ...b, dataPag: c.pag });
    }
  }
  return out;
}

// ── ações ────────────────────────────────────────────────────────────────
async function listarEmpresas() {
  const out = new Map();
  let p = 1, tot = 1;
  while (p <= tot && p <= 60) {
    const d = await b3('listedCompaniesProxy/CompanyCall/GetInitialCompanies', { language: 'pt-br', pageNumber: p, pageSize: 120 });
    for (const e of d?.results || []) if (e.issuingCompany) out.set(String(e.issuingCompany).toUpperCase(), e);
    tot = d?.page?.totalPages || 1; p++;
  }
  // a lista traz também emissoras só de dívida (sem ações): ficam as do tipo 1 ou de segmento de ações
  const ACOES_MERCADO = ['NM', 'N1', 'N2', 'MA', 'M2', 'MB', 'CMP'];
  return [...out.values()].filter(e => String(e.type) === '1' || ACOES_MERCADO.includes(String(e.market || '').toUpperCase()));
}
// Empresas que saíram da bolsa (canceladas): a B3 mantém uma lista à parte
async function listarCanceladas() {
  const out = new Map();
  for (const rota of ['GetCanceledCompanies', 'GetCanceledCompaniesSearch']) {
    let p = 1, tot = 1;
    try {
      while (p <= tot && p <= 60) {
        const d = await b3('listedCompaniesProxy/CompanyCall/' + rota, { language: 'pt-br', pageNumber: p, pageSize: 120 });
        for (const e of d?.results || []) { const k = String(e.issuingCompany || e.codeCVM || e.companyName || '').toUpperCase(); if (k && !out.has(k)) out.set(k, { ...e, cancelada: true }); }
        tot = d?.page?.totalPages || 1; p++;
      }
    } catch (e) { if (MODO === 'teste') aviso(`lista de canceladas (${rota}): ${e.message}`); }
    if (out.size) break;
  }
  return [...out.values()];
}
async function acharEmpresa(raiz) {
  const d = await b3('listedCompaniesProxy/CompanyCall/GetInitialCompanies', { language: 'pt-br', pageNumber: 1, pageSize: 20, company: raiz });
  const e = (d?.results || []).find(e => String(e.issuingCompany).toUpperCase() === raiz);
  if (e) return e;
  // fora da busca (empresa que saiu da bolsa): o complemento da B3 às vezes ainda traz o nome de pregão
  try {
    const s = await b3('listedCompaniesProxy/CompanyCall/GetListedSupplementCompany', { issuingCompany: raiz, language: 'pt-br' });
    const o = Array.isArray(s) ? s[0] : s;
    if (o?.tradingName) return { issuingCompany: raiz, tradingName: o.tradingName, codeCVM: o.codeCVM, companyName: o.tradingName, cancelada: true };
  } catch {}
  return null;
}
async function brapiProventos(ticker) {
  if (!TOKEN && !BRAPI_GRATIS.includes(ticker)) return null;
  const d = await pedir(`https://brapi.dev/api/quote/${ticker}?dividends=true`, { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}, pausa: 400 });
  const cash = d?.results?.[0]?.dividendsData?.cashDividends;
  if (!Array.isArray(cash)) return null;
  return cash.map(x => ({ com: iso(x.lastDatePrior), pag: iso(x.paymentDate), prazo: !!x.paymentDateIsDeadline, t: tipoDe(x.label), v: num(x.rate) }));
}
// ── datas de pagamento antigas por sites públicos de proventos (out/2026) ────────
// Quando nem a B3 nem a brapi têm a data de pagamento (empresas que saíram da bolsa, classes que
// deixaram de existir, lacunas pontuais), procura no Dados de Mercado e, se não achar, no PlayInvest.
// Casa pela data com + tipo + valor (até 1%). Só preenche o que estava estimado.
function linhasTabela(html) {
  const out = [];
  for (const tr of String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cel = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(c => c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (!cel.length) continue;
    const datas = cel.map(c => (c.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || [])).filter(m => m.length).map(m => `${m[3]}-${m[2]}-${m[1]}`);
    const tipoC = cel.find(c => /^(jcp|juros|jrs|dividendo|div|rend)/i.test(c)) || '';
    const valC = cel.find(c => /^\*?\s*\d+,\d+$/.test(c));
    if (datas.length < 2 || !valC) continue;
    out.push({ t: /jcp|juros|jrs/i.test(tipoC) ? 'JCP' : (/rend/i.test(tipoC) ? 'REND' : 'DIV'), v: num(valC.replace('*', '').trim()), ajustado: valC.includes('*'), com: datas[0], pag: datas[datas.length - 1] });
  }
  return out;
}
async function datasPublicas(ticker) {
  const tk = ticker.toLowerCase();
  for (const url of [`https://www.dadosdemercado.com.br/acoes/${tk}/dividendos`, `https://playinvest.com.br/dividendos/${tk}`]) {
    try {
      const html = await pedir(url, { json: false, headers: { 'User-Agent': UA, Accept: 'text/html' }, pausa: 1500, tentativas: 2 });
      const l = linhasTabela(html);
      if (l.length) return { fonte: url.includes('dadosdemercado') ? 'dadosdemercado' : 'playinvest', linhas: l };
    } catch {}
  }
  return null;
}
async function completarDatas(ticker, proventos) {
  const faltam = proventos.filter(p => p.pagEstimado && p.dataCom >= '2008-01-01');
  if (!faltam.length) return 0;
  const r = await datasPublicas(ticker);
  if (!r) return 0;
  let n = 0;
  for (const p of faltam) {
    const mesmoDia = r.linhas.filter(x => x.com === p.dataCom && x.pag && x.pag >= p.dataCom);
    const tipoOk = x => x.t === p.tipo || (p.tipo === 'REND' && x.t !== 'JCP') || (p.tipo === 'DIV' && x.t === 'REND');
    let c = mesmoDia.filter(x => tipoOk(x) && !x.ajustado && Math.abs(x.v - p.valor) <= Math.max(0.00006, p.valor * 0.01));
    if (!c.length) c = mesmoDia.filter(x => !x.ajustado && Math.abs(x.v - p.valor) <= Math.max(0.00006, p.valor * 0.01));
    if (!c.length) { const d = [...new Set(mesmoDia.filter(tipoOk).map(x => x.pag))]; if (d.length === 1) c = mesmoDia.filter(tipoOk); }
    const datas = [...new Set(c.map(x => x.pag))];
    if (datas.length !== 1) continue;
    p.dataPag = datas[0]; delete p.pagEstimado; p.fonte = (p.fonte || 'b3') + '+' + r.fonte; n++;
  }
  return n;
}
async function processarEmpresa(emp, soTickers) {
  const raiz = String(emp.issuingCompany).toUpperCase();
  const supR = await b3('listedCompaniesProxy/CompanyCall/GetListedSupplementCompany', { issuingCompany: raiz, language: 'pt-br' });
  const sup = Array.isArray(supR) ? supR[0] : supR;
  const datasRecentes = new Set((sup?.cashDividends || []).map(x => iso(x.lastDatePrior)).filter(Boolean));
  // o histórico é pedido pelo nome de pregão; alguns nomes ("AMBEV S/A", "KLABIN S/A") não devolvem
  // nada, então tenta variações até uma responder
  let hist = [];
  const nomeBase = String(emp.tradingName || '').trim();
  const variacoes = [...new Set([nomeBase, nomeBase.replace(/\s+S\/?A\.?$/i, '').trim(), nomeBase.replace(/\s+S\.A\.?$/i, '').trim(), nomeBase.split(/\s+/)[0], String(emp.companyName || '').trim(), raiz].filter(v => v && v.length >= 3))];
  for (const nome of variacoes) {
    let p = 1, tot = 1, lista = [];
    while (p <= tot && p <= 40) {
      if (p === 2 && nome !== nomeBase && !(datasRecentes.size && lista.some(x => datasRecentes.has(iso(x.lastDatePriorEx))))) break; // nome alternativo sem conferência: não baixa o resto
      const d = await b3('listedCompaniesProxy/CompanyCall/GetListedCashDividends', { language: 'pt-br', pageNumber: p, pageSize: 120, tradingName: nome });
      lista = lista.concat(d?.results || []); tot = d?.page?.totalPages || 1; p++;
    }
    // só aceita se os registros forem desta empresa (o nome curto pode trazer outra)
    if (!lista.length) continue;
    if (nome !== nomeBase) {
      // nome alternativo: confirma que é a mesma empresa (alguma data com igual à dos proventos recentes)
      // (o nome curto pode ser de outra empresa: "AMBEV" é a antiga Cia. de Bebidas, anterior à ABEV3)
      const bate = datasRecentes.size && lista.some(x => datasRecentes.has(iso(x.lastDatePriorEx)));
      if (!bate) { aviso(`${raiz}: nome "${nome}" devolveu proventos que não conferem com os recentes; ignorado`); continue; }
      aviso(`${raiz}: histórico achado pelo nome "${nome}"`);
    }
    hist = lista; break;
  }
  const classes = new Set();
  hist.forEach(x => classes.add(classeNorm(x.typeStock)));
  (sup?.cashDividends || []).forEach(x => classes.add(classeIsin(x.isinCode)));
  (sup?.stockDividends || []).forEach(x => classes.add(classeIsin(x.isinCode)));
  let feitos = 0;
  for (const classe of classes) {
    if (!CLASSE_DIGITO[classe]) continue;
    const ticker = raiz + CLASSE_DIGITO[classe];
    if (soTickers && !soTickers.includes(ticker)) continue;
    const base = hist.filter(x => classeNorm(x.typeStock) === classe).map(x => {
      const lote = num(x.quotedPerShares) || 1;
      return { tipo: tipoDe(x.corporateAction), dataCom: iso(x.lastDatePriorEx), aprovado: iso(x.dateApproval), valor: r8(num(x.valueCash) / lote), lote };
    }).filter(x => x.dataCom && x.valor > 0);
    const rec = (sup?.cashDividends || []).filter(x => classeIsin(x.isinCode) === classe).map(x => ({ com: iso(x.lastDatePrior), pag: iso(x.paymentDate), t: tipoDe(x.label), v: num(x.rate), aprov: iso(x.approvedOn) })).filter(x => x.com);
    const eventos = eventosDe(sup?.stockDividends, e => classeIsin(e.isinCode) === classe);
    if (!base.length && !rec.length && !eventos.length) continue;
    let bp = null;
    try { bp = await brapiProventos(ticker); } catch (e) { aviso(`${ticker}: brapi falhou (${e.message})`); }
    const minRec = rec.length ? rec.map(x => x.com).sort()[0] : '9999';
    const cands = (lista, x, regs) => {
      let c = lista.filter(y => y.com === x.dataCom && y.t === x.tipo);
      if (!c.length && x.tipo === 'REND') c = lista.filter(y => y.com === x.dataCom && (y.t === 'DIV' || y.t === 'JCP'));
      // out/2026: a fonte às vezes chama o provento por outro tipo (ex.: AZZA3 dez/2021, dividendo e JCP no
      // mesmo anúncio). Sem candidato do mesmo tipo, vale o da mesma data com e mesmo valor (até 1%).
      if (!c.length && regs) c = lista.filter(y => y.com === x.dataCom && regs.some(g => Math.abs(y.v - g.valor) <= Math.max(1e-7, g.valor * 0.01)));
      return c;
    };
    const proventos = [];
    const usadosRec = new Set();
    const grupos = new Map();
    for (const x of base) { const k = x.dataCom + '|' + x.tipo; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(x); }
    for (const grupo of grupos.values()) {
      const x = grupo[0];
      const regs = grupo.map(g => ({ tipo: g.tipo, dataCom: g.dataCom, aprovado: g.aprovado || undefined, valor: g.valor, ...(g.lote > 1 ? { lote: g.lote } : {}) }));
      // 1) B3 recente (data oficial)
      const cr = x.dataCom >= minRec ? cands(rec, x, regs) : [];
      cr.forEach(y => usadosRec.add(y));
      let r = cr.length ? atribuir(regs, cr) : null;
      if (r) { r.forEach(p => proventos.push({ ...p, fonte: 'b3' })); continue; }
      // 2) brapi (data dos anos anteriores); "prazo" só se não houver data exata
      const cb = bp ? cands(bp, x, regs) : [];
      const reais = cb.filter(y => y.pag && !y.prazo);
      r = atribuir(regs, reais.length ? reais : cb);
      if (r) { r.forEach(p => proventos.push({ ...p, ...(reais.length ? {} : { pagPrazo: true }), fonte: 'b3+brapi' })); continue; }
      // 3) sem data de pagamento
      regs.forEach(p => proventos.push({ ...p, dataPag: null, pagEstimado: true, fonte: 'b3' }));
    }
    // sem histórico na B3 (nome de pregão que a B3 não reconhece): a brapi vira a base dos anos anteriores
    if (!base.length && bp?.length) {
      const antes = proventos.length;
      for (const y of bp) {
        if (!y.com || !(y.v > 0) || y.com >= minRec) continue;
        proventos.push({ tipo: y.t, dataCom: y.com, valor: r8(y.v), dataPag: y.pag || null, ...(y.pag ? (y.prazo ? { pagPrazo: true } : {}) : { pagEstimado: true }), fonte: 'brapi' });
      }
      if (proventos.length > antes) aviso(`${ticker}: histórico da B3 indisponível; ${proventos.length - antes} proventos anteriores vieram da brapi`);
    }
    // anunciados na B3 recente que ainda não estão no histórico
    for (const y of rec) {
      if (usadosRec.has(y) || !(y.v > 0)) continue;
      if (proventos.some(p => p.dataCom === y.com && p.tipo === y.t)) continue;
      proventos.push({ tipo: y.t, dataCom: y.com, aprovado: y.aprov || undefined, valor: r8(y.v), dataPag: y.pag || null, ...(y.pag ? {} : { pagEstimado: true }), fonte: 'b3' });
    }
    // out/2026: sem data de pagamento, mas outro provento do MESMO anúncio (mesma data com e mesma
    // aprovação) tem data real e única: usa essa data, marcada como pagIrmao
    for (const p of proventos) {
      if (!p.pagEstimado) continue;
      const datas = [...new Set(proventos.filter(q => q !== p && q.dataCom === p.dataCom && q.dataPag && !q.pagEstimado && !q.pagPrazo && (q.aprovado || '') === (p.aprovado || '')).map(q => q.dataPag))];
      if (datas.length === 1) { p.dataPag = datas[0]; delete p.pagEstimado; p.pagIrmao = true; }
    }
    try { const k = await completarDatas(ticker, proventos); if (k) aviso(`${ticker}: ${k} datas de pagamento antigas completadas por site público`); } catch (e) { aviso(`${ticker}: busca de datas antigas falhou (${e.message})`); }
    const obj = { ticker, tipoAtivo: 'acao', classe, empresa: emp.tradingName, nome: emp.companyName || undefined, codigoCVM: emp.codeCVM || undefined, atualizado: HOJE, proventos: ordenar(proventos), eventos };
    gravar(ticker, obj);
    feitos++;
    if (MODO === 'teste' || relatorio.amostras.length < 3) relatorio.amostras.push(resumo(obj));
  }
  return feitos;
}

// ── FIIs ─────────────────────────────────────────────────────────────────
let cookie = '';
async function sessaoFnet() {
  const r = await fetch(FN + 'abrirGerenciadorDocumentosCVM', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  cookie = sc.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}
const fnet = (url, json = true) => pedir(url, { json, pausa: 700, headers: { 'User-Agent': UA, Accept: json ? 'application/json, text/javascript, */*' : '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: FN + 'abrirGerenciadorDocumentosCVM', ...(cookie ? { Cookie: cookie } : {}) } });
function cnpjValido(c) {
  c = String(c || '').replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const soma = pesos.reduce((t, p, i) => t + p * +c[i], 0); const r = soma % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +c[12] && dv(13) === +c[13];
}
// CNPJ do próprio fundo numa resposta da B3 (ignora administrador, gestor etc.; confere os dígitos)
function acharCnpj(o, prof = 0) {
  if (!o || typeof o !== 'object' || prof > 5) return '';
  for (const [k, v] of Object.entries(o)) {
    if (!/cnpj/i.test(k) || /admin|gestor|manager|auditor|custod|escritur|lider|coordenad/i.test(k)) continue;
    const d = String(v ?? '').replace(/\D/g, '');
    if (cnpjValido(d)) return d;
  }
  for (const v of Object.values(o)) { const d = acharCnpj(v, prof + 1); if (d) return d; }
  return '';
}
// Cadastro de fundos da CVM (CNPJ, nome, tipo): usado para achar o CNPJ de Fiagros e FI-Infra pelo nome
let CADASTRO = null;
let HISTORICO_FII = null;
const STATUS_FNET = {};
// versão da leitura dos avisos do FundosNET (v3 = 19/10/2026: código por ativo e recibos fora)
const LEITURA_FNET = 'v3';
// versão do casamento das datas de pagamento das ações (v2 = 19/10/2026: tipo trocado e mesmo anúncio)
const DATAS_ACOES = 'v2';
const normNome = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(FUNDO|FUNDOS|INVESTIMENTO|INVESTIMENTOS|CLASSE|COTAS|RESPONSABILIDADE|LIMITADA|LTDA|DAS|DOS|NAS|NOS|PARA|COM|FII|FIAGRO|INFRA|IMOBILIARIO|CADEIAS|PRODUTIVAS|AGROINDUSTRIAIS|UNICA|FIC|FIF|FIP|RESP|LIMIT|LIM)$/.test(w));
function carregarCadastro() {
  if (CADASTRO) return CADASTRO;
  CADASTRO = [];
  try {
    if (!fs.existsSync('/tmp/cad')) execSync('curl -sSfL --max-time 600 -o /tmp/cad.zip https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip && rm -rf /tmp/cad && mkdir -p /tmp/cad && unzip -o -q /tmp/cad.zip -d /tmp/cad');
    const arq = fs.readdirSync('/tmp/cad').find(n => /classe/i.test(n)) || fs.readdirSync('/tmp/cad')[0];
    const linhas = new TextDecoder('latin1').decode(fs.readFileSync(path.join('/tmp/cad', arq))).split(/\r?\n/);
    const cab = linhas[0].split(';');
    const iC = cab.findIndex(c => /^CNPJ_Classe/i.test(c)), iT = cab.findIndex(c => /^Tipo_Classe/i.test(c)), iN = cab.findIndex(c => /^Denominacao/i.test(c)), iS = cab.findIndex(c => /^Situacao/i.test(c));
    for (const l of linhas.slice(1)) {
      const c = l.split(';'); const tipo = c[iT] || '';
      if (!/FII|FIAGRO|FIF|FIDC/i.test(tipo)) continue;
      if (iS >= 0 && /CANCEL/i.test(c[iS] || '')) continue;
      const cnpj = String(c[iC] || '').replace(/\D/g, '');
      if (cnpjValido(cnpj)) CADASTRO.push({ cnpj, tipo, nome: c[iN] || '', tokens: new Set(normNome(c[iN])) });
    }
  } catch (e) { aviso('cadastro da CVM: ' + e.message.slice(0, 200)); }
  return CADASTRO;
}
// Candidatos a CNPJ pelo nome (cadastro da CVM), do mais parecido para o menos. Não decide sozinho:
// cada candidato é confirmado no FundosNET (o aviso de rendimentos traz o código de negociação).
function candidatosPeloNome(nome) {
  const tk = normNome(nome);
  if (!tk.length) return [];
  return carregarCadastro()
    .filter(f => /FII|FIAGRO|FIF|FIDC/i.test(f.tipo))
    .map(f => ({ ...f, n: tk.filter(t => f.tokens.has(t)).length }))
    .filter(f => f.tokens.has(tk[0]) && f.n >= Math.max(2, Math.ceil(tk.length * 0.4)))
    .sort((x, y) => y.n - x.n)
    .slice(0, 6);
}
async function confirmarCnpj(cnpj, sigla) {
  for (const tf of ['1', '', '11', '12', '13', '14']) {
    const base = { d: '1', s: '0', l: '5', 'o[0][dataEntrega]': 'desc', cnpjFundo: cnpj };
    if (tf) base.tipoFundo = tf;
    let d; try { d = await fnet(FN + 'pesquisarGerenciadorDocumentosDados?' + new URLSearchParams(base)); } catch { continue; }
    const docs = d?.data || [];
    if (!docs.length) continue;
    if (docs.some(x => new RegExp('\\b' + sigla).test(String(x.codSegNegociacao || '') + ' ' + String(x.nomePregao || '')))) return true;
    const est = docs.find(x => /estrutur/i.test(String(x.categoriaDocumento || '') + String(x.tipoDocumento || ''))) || docs[0];
    try {
      let xml = String(await fnet(FN + 'downloadDocumento?id=' + est.id, false) || '').trim();
      if (xml.startsWith('"')) xml = JSON.parse(xml);
      if (!xml.startsWith('<')) xml = Buffer.from(xml, 'base64').toString('utf8');
      if (new RegExp('<Cod(igo)?Negociacao[^>]*>\\s*' + sigla, 'i').test(xml) || new RegExp('BR' + sigla).test(xml)) return true;
    } catch {}
    return false;
  }
  return false;
}
async function cnpjPeloNome(nome, sigla) {
  for (const c of candidatosPeloNome(nome)) if (await confirmarCnpj(c.cnpj, sigla)) return c;
  return null;
}
async function listarFundos() {
  // A B3 não devolve a lista de fundos (testado em 16/10/2026). A lista vem do informe mensal
  // estruturado dos FIIs na CVM (dados abertos): CNPJ e ISIN da cota (BRHGLGCTF004 → HGLG11).
  const out = new Map();
  const ano = Number(HOJE.slice(0, 4));
  for (const a of [ano, ano - 1]) {
    let txt = '';
    try {
      execSync(`curl -sSfL --max-time 300 -o /tmp/fii.zip https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${a}.zip && rm -rf /tmp/fii && mkdir -p /tmp/fii && unzip -o -q /tmp/fii.zip -d /tmp/fii`);
      const arq = fs.readdirSync('/tmp/fii').find(n => /geral/i.test(n)) || fs.readdirSync('/tmp/fii')[0];
      txt = new TextDecoder('latin1').decode(fs.readFileSync(path.join('/tmp/fii', arq)));
    } catch (e) { aviso(`lista de FIIs da CVM ${a}: ${e.message.slice(0, 200)}`); continue; }
    const linhas = txt.split(/\r?\n/).filter(Boolean);
    const cab = linhas[0].split(';').map(c => c.trim());
    const iC = cab.findIndex(c => /^CNPJ_Fundo/i.test(c)), iI = cab.findIndex(c => /ISIN/i.test(c)), iN = cab.findIndex(c => /^Nome_Fundo/i.test(c));
    if (iC < 0 || iI < 0) { aviso(`lista de FIIs da CVM ${a}: colunas não encontradas (${cab.join(', ').slice(0, 300)})`); continue; }
    for (const l of linhas.slice(1)) {
      const c = l.split(';');
      const isin = String(c[iI] || '').trim().toUpperCase();
      const cnpj = String(c[iC] || '').replace(/\D/g, '');
      if (!/^BR[A-Z0-9]{4}CTF/.test(isin) || cnpj.length !== 14) continue;
      const sigla = isin.slice(2, 6);
      if (!out.has(sigla)) out.set(sigla, { sigla, ticker: sigla + '11', cnpj, typeFund: 7, nome: iN >= 0 ? String(c[iN] || '').trim() : '' });
    }
    if (out.size) break;
  }
  return [...out.values()];
}
// FIIs de anos anteriores (inclui os que saíram da bolsa ou foram incorporados): informes mensais da CVM desde 2016
function fiisHistoricosCVM() {
  const out = new Map();
  const ano = Number(HOJE.slice(0, 4));
  for (let a = ano; a >= 2016; a--) {
    try {
      const base = 'https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/';
      execSync(`(curl -sSfL --max-time 300 -o /tmp/fh.zip ${base}inf_mensal_fii_${a}.zip || curl -sSfL --max-time 300 -o /tmp/fh.zip ${base}HIST/inf_mensal_fii_${a}.zip) && rm -rf /tmp/fh && mkdir -p /tmp/fh && unzip -o -q /tmp/fh.zip -d /tmp/fh`);
      const arq = fs.readdirSync('/tmp/fh').find(n => /geral/i.test(n)) || fs.readdirSync('/tmp/fh')[0];
      const linhas = new TextDecoder('latin1').decode(fs.readFileSync(path.join('/tmp/fh', arq))).split(/\r?\n/);
      const cab = linhas[0].split(';');
      const iC = cab.findIndex(c => /^CNPJ_Fundo/i.test(c)), iI = cab.findIndex(c => /ISIN/i.test(c)), iN = cab.findIndex(c => /^Nome_Fundo/i.test(c));
      if (iC < 0 || iI < 0) continue;
      for (const l of linhas.slice(1)) {
        const c = l.split(';'); const isin = String(c[iI] || '').trim().toUpperCase(); const cnpj = String(c[iC] || '').replace(/\D/g, '');
        if (!/^BR[A-Z0-9]{4}CTF/.test(isin) || !cnpjValido(cnpj)) continue;
        const sigla = isin.slice(2, 6);
        if (!out.has(sigla)) out.set(sigla, { sigla, ticker: sigla + '11', cnpj, typeFund: 7, nome: iN >= 0 ? String(c[iN] || '').trim() : '', ultimoAno: a });
      }
    } catch (e) { if (MODO === 'teste') aviso(`informe da CVM ${a}: ${e.message.slice(0, 120)}`); }
  }
  return out;
}
// Todos os fundos negociados na bolsa (FIIs, Fiagros, FI-Infra...) pelo arquivo público de
// instrumentos da B3 (InstrumentsConsolidated, atualizado todo dia útil).
async function listarFundosNegociados() {
  for (let k = 1; k <= 7; k++) {
    const dia = new Date(Date.now() - (3 + 24 * k) * 3600 * 1000).toISOString().slice(0, 10);
    try {
      const t = await pedir(`https://arquivos.b3.com.br/api/download/requestname?fileName=InstrumentsConsolidated&date=${dia}&recaptchaToken=`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, pausa: 500, tentativas: 2 });
      if (!t?.token) continue;
      await espera(500);
      const rr = await fetch(`https://arquivos.b3.com.br/api/download/?token=${t.token}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
      if (!rr.ok) continue;
      const bruto = Buffer.from(await rr.arrayBuffer());
      const utf = bruto.toString('utf8');
      const csv = utf.includes('\uFFFD') ? new TextDecoder('latin1').decode(bruto) : utf;
      const linhas = String(csv || '').split(/\r?\n/).filter(Boolean);
      const iCab = linhas.findIndex(l => /TckrSymb/.test(l));
      if (iCab < 0) continue;
      const cab = linhas[iCab].split(';');
      const col = n => cab.findIndex(c => c.trim() === n);
      const iT = col('TckrSymb'), iC = col('SctyCtgyNm'), iI = col('ISIN'), iN = col('CrpnNm'), iE = col('SpcfctnCd');
      const out = new Map(), categorias = {};
      for (const l of linhas.slice(iCab + 1)) {
        const c = l.split(';');
        const tk = String(c[iT] || '').trim().toUpperCase(), cat = String(c[iC] || '').trim().toUpperCase(), isin = String(c[iI] || '').trim().toUpperCase();
        if (!/^[A-Z]{4}11$/.test(tk)) continue;
        categorias[cat] = (categorias[cat] || 0) + 1;
        if (!/FUND|FII|AGRO|INFRA/.test(cat) && !/^BR[A-Z0-9]{4}CTF/.test(isin)) continue;
        if (/ETF/.test(cat)) continue;
        const nome = String(c[iN] || '').trim();
        if (!out.has(tk)) out.set(tk, { sigla: tk.slice(0, 4), ticker: tk, typeFund: 7, nome, tipoAtivo: /AGRO/i.test(nome) ? 'fiagro' : (/INFRA|\bINF\b|\bIE\b|INCENTIVAD/i.test(nome) ? 'fiinfra' : undefined), cat, espec: String(c[iE] || '').trim() });
      }
      if (MODO === 'teste') aviso(`Arquivo de instrumentos da B3 (${dia}): categorias dos tickers terminados em 11: ${Object.entries(categorias).map(([k, v]) => k + ': ' + v).join(', ')}`);
      if (out.size) return [...out.values()];
    } catch (e) { if (MODO === 'teste' && k === 1) aviso(`Arquivo de instrumentos da B3: ${e.message}`); }
  }
  return [];
}
// Plano B para a lista de Fiagros: cadastro de fundos da CVM (só CNPJ e nome, sem ticker)
function contarFiagrosCVM() {
  try {
    execSync('curl -sSfL --max-time 600 -o /tmp/cad.zip https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip && rm -rf /tmp/cad && mkdir -p /tmp/cad && unzip -o -q /tmp/cad.zip -d /tmp/cad');
    const arq = fs.readdirSync('/tmp/cad').find(n => /classe/i.test(n)) || fs.readdirSync('/tmp/cad')[0];
    const txt = new TextDecoder('latin1').decode(fs.readFileSync(path.join('/tmp/cad', arq)));
    const linhas = txt.split(/\r?\n/);
    const cab = linhas[0].split(';');
    const iT = cab.findIndex(c => /^Tipo_Classe/i.test(c)), iS = cab.findIndex(c => /Situacao/i.test(c));
    const tipos = {};
    let fiagro = 0;
    for (const l of linhas.slice(1)) { const c = l.split(';'); const t = c[iT] || ''; tipos[t] = (tipos[t] || 0) + 1; if (/AGRO/i.test(t) && (iS < 0 || !/CANCEL/i.test(c[iS] || ''))) fiagro++; }
    return `${arq}: ${fiagro} classes Fiagro ativas. Tipos: ${Object.entries(tipos).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => k + ': ' + v).join(', ')}`;
  } catch (e) { return 'falhou: ' + e.message.slice(0, 200); }
}
async function detalheFundo(sigla, typeFund = 7) {
  try { return await b3('fundsProxy/fundsCall/GetDetailFundSIG', { typeFund, cnpj: '0', identifierFund: sigla }); } catch { return null; }
}
// Lê os rendimentos e amortizações de um aviso estruturado do FundosNET.
// out/2026 (diagnóstico de 19/10): um mesmo aviso pode trazer vários ativos do fundo (a cota e os
// recibos de subscrição VISC13, VISC14...), cada um com seu código e seu valor pró-rata. Os avisos
// antigos usam as tags CodNegociacaoCota/CodISINCota; os novos, CodNegociacao/CodISIN, repetidas por
// ativo. Cada valor fica com o código do ativo a que pertence; os de recibo são descartados.
const ehRecibo = (cod, isin) => /^[A-Z]{4}1[2-9]$/.test(cod) || /^BR[A-Z0-9]{4}R[0-9A-Z]{2}M/.test(isin);
function lerAviso(xml) {
  const tag = (b, re) => { const m = b.match(new RegExp('<(' + re + ')\\b[^>]*>([^<]*)</\\1>', 'i')); return m ? m[2].trim() : ''; };
  const re = /<(CodNegociacaoCota|CodNegociacao|CodigoNegociacao)\b[^>]*>([^<]*)<\/\1>|<(CodISINCota|CodISIN)\b[^>]*>([^<]*)<\/\3>|<(Rendimento|Amortizacao)\b[^>]*>([\s\S]*?)<\/\5>/gi;
  const codigos = [], blocos = [];
  let cod = '', isin = '', m;
  while ((m = re.exec(xml))) {
    if (m[1]) { cod = m[2].trim().toUpperCase(); codigos.push({ cod, isin }); }
    else if (m[3]) { isin = m[4].trim().toUpperCase(); if (codigos.length && !codigos[codigos.length - 1].isin) codigos[codigos.length - 1].isin = isin; }
    else blocos.push({ amort: /^Amortizacao$/i.test(m[5]), b: m[0], cod, isin });
  }
  // formato com todos os códigos antes de todos os valores: casa pela ordem (1º código com 1º valor)
  if (codigos.length > 1 && blocos.length === codigos.length && blocos.every(x => x.cod === blocos[0].cod)) blocos.forEach((x, i) => { x.cod = codigos[i].cod; x.isin = codigos[i].isin; });
  const out = [];
  let recibos = 0;
  for (const x of blocos) {
    if (ehRecibo(x.cod, x.isin)) { recibos++; continue; }
    const valor = num(tag(x.b, 'ValorProventoCota|ValorPorCota|ValorProvento|Valor'));
    if (!(valor > 0)) continue;
    out.push({ tipo: x.amort ? 'AMORT' : 'REND', dataCom: iso(tag(x.b, 'DataBase|DataCom|DataBaseCotistas')), dataPag: iso(tag(x.b, 'DataPagamento|DataPagto')), valor, periodo: tag(x.b, 'PeriodoReferencia'), codigo: x.cod });
  }
  return { itens: out.filter(x => x.dataCom), codigo: codigos[0]?.cod || '', recibos, soRecibos: blocos.length > 0 && recibos === blocos.length };
}
async function baixarAviso(id) {
  try {
    let xml = String(await fnet(FN + 'downloadDocumento?id=' + id, false) || '').trim();
    if (xml.startsWith('"')) xml = JSON.parse(xml);
    if (!xml.startsWith('<')) xml = Buffer.from(xml, 'base64').toString('utf8');
    return xml;
  } catch { return null; }
}
async function avisosFnet(cnpj, ate) {
  // FII = tipoFundo 1; Fiagro e FI-Infra usam outros tipos: tenta até achar avisos estruturados
  let docs = [], tipoUsado = '';
  for (const tf of ['1', '', '11', '12', '13', '14', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
    const lista = [];
    let s = 0, total = Infinity;
    while (s < total && s < 3000) {
      const base = { d: '1', s: String(s), l: '100', 'o[0][dataEntrega]': 'desc', cnpjFundo: cnpj, idCategoriaDocumento: '14', idTipoDocumento: '41', idEspecieDocumento: '0' };
      if (tf) base.tipoFundo = tf;
      let d;
      try { d = await fnet(FN + 'pesquisarGerenciadorDocumentosDados?' + new URLSearchParams(base)); } catch { break; }
      total = d?.recordsFiltered ?? 0;
      const lote = d?.data || [];
      lista.push(...lote);
      if (!lote.length) break;
      s += 100;
    }
    if (lista.length) { docs = lista; tipoUsado = tf || 'sem tipo'; break; }
  }
  const todos = [], pendentes = [];
  let lidos = 0, falhas = 0, ignorados = 0;
  for (const doc of docs) {
    const ref = iso(doc.dataReferencia) || iso(doc.dataEntrega);
    if (ref && ref >= ate) continue; // período recente vem da B3
    // aviso cancelado ou substituído por um refeito: não entra
    const st = String(doc.situacaoDocumento ?? '') + '|' + String(doc.descricaoStatus ?? '') + '|' + String(doc.status ?? '');
    STATUS_FNET[st] = (STATUS_FNET[st] || 0) + 1;
    if (/cancel|inativ|exclu|substitu/i.test(String(doc.descricaoStatus ?? '') + ' ' + String(doc.situacaoDocumento ?? '')) || /^(C|I|E|X)$/i.test(String(doc.situacaoDocumento ?? ''))) { ignorados++; continue; }
    if (tempoAcabou()) throw new Error('TEMPO');
    const xml = await baixarAviso(doc.id);
    if (xml == null) { pendentes.push(doc); continue; }
    if (tratar(doc, xml)) continue;
  }
  // out/2026: o FundosNET às vezes responde erro (HTTP 520) e o aviso se perdia (ex.: HGLG11 de mai/2022
  // ficou só com o valor de um recibo). Os que falharam têm mais uma chance, com calma.
  if (pendentes.length) {
    await espera(15000);
    for (const doc of pendentes) {
      if (tempoAcabou()) throw new Error('TEMPO');
      await espera(2500);
      const xml = await baixarAviso(doc.id);
      if (xml == null) { falhas++; continue; }
      tratar(doc, xml);
    }
  }
  function tratar(doc, xml) {
    const r = lerAviso(xml);
    if (r.soRecibos) { ignorados++; return true; } // aviso só de recibos de subscrição
    if (!r.itens.length) { falhas++; if (relatorio.avisos.filter(a => a.startsWith('XML')).length < 3) aviso(`XML não lido (doc ${doc.id}, ${doc.dataReferencia}): ${xml.slice(0, 700).replace(/\s+/g, ' ')}`); return true; }
    lidos++;
    for (const it of r.itens) todos.push({ ...it, id: doc.id });
    return false;
  }
  // Avisos refeitos: o mesmo rendimento (mesma data com e valor) em mais de um aviso fica só o do mais
  // novo. Valores diferentes na mesma data com vindos de avisos diferentes ficam todos (complemento,
  // parcelas de amortização), já que avisos cancelados foram descartados acima.
  const porChave = new Map();
  for (const it of todos) {
    const k = it.tipo + '|' + it.dataCom + '|' + it.valor;
    const ant = porChave.get(k);
    if (!ant) { porChave.set(k, [it]); continue; }
    if (ant[0].id === it.id) { if (!ant.some(a => a.dataPag === it.dataPag)) ant.push(it); } // mesmo aviso: só datas de pagamento diferentes contam
    else if (it.id > ant[0].id) porChave.set(k, [it]); // aviso mais novo substitui
  }
  return { itens: [...porChave.values()].flat(), docs: docs.length, lidos, falhas, tipoUsado, ignorados };
}
async function brapiFundo(ticker) {
  if (!TOKEN) return null;
  const d = await pedir(`https://brapi.dev/api/v2/fii/dividends?symbols=${ticker}&startDate=2005-01-01&sortOrder=asc`, { headers: { Authorization: 'Bearer ' + TOKEN }, pausa: 400 });
  // formato não documentado em detalhe: procura listas de objetos com data e valor
  const achados = [];
  const varrer = (o, prof = 0) => {
    if (!o || prof > 6) return;
    if (Array.isArray(o)) { o.forEach(x => varrer(x, prof + 1)); return; }
    if (typeof o !== 'object') return;
    const k = Object.keys(o);
    const com = o.lastDatePrior || o.recordDate || o.dataCom || o.baseDate || o.exDate;
    const valor = o.rate ?? o.value ?? o.amount ?? o.valor;
    if (com && valor != null && k.length < 30) { achados.push({ tipo: /amort/i.test(String(o.label || o.type || '')) ? 'AMORT' : 'REND', dataCom: iso(com), dataPag: iso(o.paymentDate || o.payDate || o.dataPagamento) || null, valor: r8(num(valor)) }); return; }
    Object.values(o).forEach(v => varrer(v, prof + 1));
  };
  varrer(d);
  return achados.filter(x => x.dataCom && x.valor > 0);
}
function tipoFundoDe(nome, det) {
  const t = (String(nome || '') + ' ' + JSON.stringify(det || {}).slice(0, 4000)).toUpperCase();
  if (/FIAGRO|AGRONEG|CADEIAS AGRO/.test(t)) return 'fiagro';
  if (/INFRA|FI-INFRA|INFRAESTRUTURA/.test(t)) return 'fiinfra';
  return 'fii';
}
async function processarFundo(f) {
  const ticker = f.ticker || f.sigla + '11';
  // a B3 usa um código por tipo de fundo (FII 7; Fiagro e FI-Infra outros): tenta até achar
  let det = null, supD = null, typeFund = f.typeFund || 7;
  for (const tf of [...new Set([typeFund, 7, 34, 27, 26, 35, 36])]) {
    const d = await detalheFundo(f.sigla, tf);
    if (d && acharCnpj(d)) { det = d; typeFund = tf; break; }
    if (!det && d && JSON.stringify(d).length > 50) det = d;
  }
  try { supD = await b3('fundsProxy/fundsCall/GetListedSupplementFunds', { cnpj: '', identifierFund: f.sigla, typeFund }); } catch (e) { aviso(`${ticker}: B3 recente falhou (${e.message})`); }
  const tipoAtivo = f.tipoAtivo || tipoFundoDe(f.nome, det);
  let cnpj = f.cnpj || acharCnpj(det) || acharCnpj(supD) || '', origemCnpj = f.cnpj ? 'lista' : (cnpj ? 'B3' : '');
  // fundo que saiu da bolsa ou foi incorporado: CNPJ pelos informes da CVM desde 2016
  if (!cnpj) { const h = (HISTORICO_FII ||= fiisHistoricosCVM()).get(f.sigla); if (h) { cnpj = h.cnpj; origemCnpj = 'informes da CVM (até ' + h.ultimoAno + ')'; } }
  // Fiagros e FI-Infra: candidatos pelo nome no cadastro da CVM, confirmados no FundosNET
  if (!cnpj && f.nome) { const m = await cnpjPeloNome(f.nome, f.sigla); if (m) { cnpj = m.cnpj; origemCnpj = 'CVM pelo nome, confirmado no FundosNET (' + m.nome.slice(0, 60) + ')'; } }
  if (MODO === 'teste') aviso(`${ticker}: resposta da B3 (detalhe) ${JSON.stringify(det || {}).slice(0, 300)}`);
  // a B3 lista também recibos de subscrição e outras classes: fica a cota principal (ISIN mais frequente)
  const cont = {}; (supD?.cashDividends || []).forEach(x => { const k = x.isinCode || ''; cont[k] = (cont[k] || 0) + 1; });
  const isinPrincipal = Object.entries(cont).sort((a, b) => b[1] - a[1])[0]?.[0];
  const vistosRec = new Set();
  const rec = (supD?.cashDividends || []).filter(x => (x.isinCode || '') === isinPrincipal).filter(x => { const k = [x.label, x.lastDatePrior, x.paymentDate, x.rate].join('|'); if (vistosRec.has(k)) return false; vistosRec.add(k); return true; }).map(x => ({ tipo: tipoDe(x.label), dataCom: iso(x.lastDatePrior), dataPag: iso(x.paymentDate) || null, valor: r8(num(x.rate)), aprovado: iso(x.approvedOn) || undefined, fonte: 'b3' })).filter(x => x.dataCom && x.valor > 0);
  const corte = rec.length ? rec.map(x => x.dataCom).sort()[0] : HOJE;
  let antigos = [], info = { docs: 0, lidos: 0, falhas: 0, tipoUsado: '' };
  if (cnpj) {
    const r = await avisosFnet(cnpj, corte);
    info = r;
    antigos = r.itens.filter(x => x.dataCom < corte).map(x => ({ tipo: x.tipo, dataCom: x.dataCom, dataPag: x.dataPag || null, ...(x.dataPag ? {} : { pagEstimado: true }), valor: r8(x.valor), fonte: 'fundosnet' }));
  }
  // sem avisos estruturados no FundosNET: histórico pela brapi (só com a chave)
  if (!antigos.length) {
    try {
      const bf = await brapiFundo(ticker);
      if (bf?.length) antigos = bf.filter(x => x.dataCom < corte).map(x => ({ ...x, ...(x.dataPag ? {} : { pagEstimado: true }), fonte: 'brapi' }));
    } catch (e) { aviso(`${ticker}: brapi de fundos falhou (${e.message})`); }
  }
  if (MODO === 'teste') aviso(`${ticker}: tipo ${tipoAtivo}, código B3 ${typeFund}, CNPJ ${cnpj || 'não encontrado'}${origemCnpj ? ' (' + origemCnpj + ')' : ''}, nome na B3 "${f.nome || '-'}", FundosNET ${info.docs} avisos (tipo ${info.tipoUsado || '-'}), lidos ${info.lidos}, recentes B3 ${rec.length}, histórico ${antigos.length}${antigos.length || !TOKEN ? '' : ' (brapi sem dados)'}${!info.docs && !TOKEN ? ' (sem chave da brapi para tentar o histórico)' : ''}`);
  const eventos = eventosDe(supD?.stockDividends, e => !isinPrincipal || !e.isinCode || e.isinCode === isinPrincipal);
  if (!rec.length && !antigos.length && !eventos.length) return 0;
  const obj = { ticker, tipoAtivo, nome: f.nome || undefined, cnpj: cnpj || undefined, isin: isinPrincipal || undefined, atualizado: HOJE, proventos: ordenar([...rec, ...antigos]), eventos, avisosLidos: info.lidos, avisosFalhos: info.falhas, avisosIgnorados: info.ignorados || 0 };
  gravar(ticker, obj);
  if (MODO === 'teste' || relatorio.amostras.length < 3) relatorio.amostras.push(resumo(obj));
  return 1;
}

// ── relatório ────────────────────────────────────────────────────────────
function resumo(o) {
  const pv = o.proventos;
  const desde16 = pv.filter(p => p.dataCom >= '2016-01-01');
  const datas = pv.map(p => p.dataCom).sort();
  return {
    ticker: o.ticker, tipo: o.tipoAtivo, proventos: pv.length, desde: datas[0] || '-',
    desde2016: desde16.length, comDataPag2016: desde16.filter(p => p.dataPag).length,
    estimados: pv.filter(p => p.pagEstimado).length, parcelas: pv.filter(p => p.parcela).length,
    lote: pv.filter(p => p.lote).length, eventos: o.eventos.length,
    ultimos: pv.slice(0, 3).map(p => `${p.tipo} com ${p.dataCom} pag ${p.dataPag || 'estimada'} R$ ${p.valor}${p.parcela ? ' (parc. ' + p.parcela + ')' : ''}`).join(' · '),
    eventosTxt: o.eventos.slice(0, 6).map(e => `${e.tipo} ${e.dataCom} x${e.multiplicador ?? e.fator}`).join(' · ')
  };
}
function gravarIndice() {
  const arq = path.join(SAIDA, 'indice.json');
  let ind = { ativos: {} };
  try { ind = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch {}
  ind.ativos = ind.ativos || {};
  for (const tk of relatorio.gravados) {
    try { const o = JSON.parse(fs.readFileSync(path.join(SAIDA, tk + '.json'), 'utf8')); ind.ativos[tk] = { t: o.tipoAtivo, n: o.proventos.length, e: o.eventos.length, u: o.atualizado }; } catch {}
  }
  ind.atualizado = HOJE;
  ind.total = Object.keys(ind.ativos).length;
  fs.mkdirSync(SAIDA, { recursive: true });
  fs.writeFileSync(arq, JSON.stringify(ind));
}
function escreverResumo(extra) {
  const esc = s => String(s ?? '').replace(/\|/g, '/');
  let md = `# Base de proventos BR: modo ${MODO}\n\n${extra.join('\n\n')}\n\n`;
  md += `Gravados nesta execução: **${relatorio.gravados.length}** · erros: ${relatorio.erros.length} · chave da brapi: ${TOKEN ? 'sim' : 'não (só PETR4, VALE3, MGLU3, ITUB4 com data de pagamento antiga)'}\n\n`;
  if (relatorio.amostras.length) {
    md += '| Ativo | Proventos | Desde | Desde 2016 | Com data de pag. (2016+) | Data estimada (total) | Parcelas | Lote de mil | Eventos |\n|---|---|---|---|---|---|---|---|---|\n';
    for (const a of relatorio.amostras) md += `| ${a.ticker} | ${a.proventos} | ${a.desde} | ${a.desde2016} | ${a.comDataPag2016} | ${a.estimados} | ${a.parcelas} | ${a.lote} | ${a.eventos} |\n`;
    md += '\n## Amostras\n';
    for (const a of relatorio.amostras) md += `\n**${a.ticker}**: ${esc(a.ultimos)}${a.eventosTxt ? '\n\nEventos: ' + esc(a.eventosTxt) : ''}\n`;
  }
  if (relatorio.erros.length) md += '\n## Erros\n\n' + relatorio.erros.slice(0, 40).map(e => '- ' + esc(e)).join('\n') + '\n';
  if (relatorio.avisos.length) md += '\n## Avisos\n\n' + relatorio.avisos.slice(0, 40).map(e => '- ' + esc(e).slice(0, 900)).join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
}

// ── atualização diária (modo atualizar) ─────────────────────────────────
// Gratuita: usa só a B3 (últimos ~12 meses, com data de pagamento oficial). Dentro dessa janela a
// B3 é a fonte oficial e substitui o que havia; o histórico anterior fica como está. Ativos novos
// na bolsa (estreias) entram com a carga completa daquele ativo.
const lerArq = tk => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, tk + '.json'), 'utf8')); } catch { return null; } };
function mesclarJanela(obj, rec, eventosNovos) {
  const antes = JSON.stringify([obj.proventos, obj.eventos]);
  if (rec.length) {
    const minRec = rec.map(x => x.dataCom).sort()[0];
    const fora = obj.proventos.filter(p => p.dataCom < minRec);
    obj.proventos = ordenar([...fora, ...rec]);
  }
  if (eventosNovos?.length) {
    const k = e => [e.tipo, e.dataCom, e.fator].join('|');
    const ja = new Set(obj.eventos.map(k));
    for (const e of eventosNovos) if (!ja.has(k(e))) obj.eventos.push(e);
    obj.eventos = ordenar(obj.eventos);
  }
  const mudou = JSON.stringify([obj.proventos, obj.eventos]) !== antes;
  if (mudou) obj.atualizado = HOJE;
  return mudou;
}
async function atualizarEmpresa(raiz, tickers) {
  const supR = await b3('listedCompaniesProxy/CompanyCall/GetListedSupplementCompany', { issuingCompany: raiz, language: 'pt-br' });
  const sup = Array.isArray(supR) ? supR[0] : supR;
  if (!sup) return 0;
  let n = 0;
  for (const tk of tickers) {
    const obj = lerArq(tk);
    if (!obj?.classe) continue;
    const rec = (sup.cashDividends || []).filter(x => classeIsin(x.isinCode) === obj.classe)
      .map(x => ({ tipo: tipoDe(x.label), dataCom: iso(x.lastDatePrior), aprovado: iso(x.approvedOn) || undefined, valor: r8(num(x.rate)), dataPag: iso(x.paymentDate) || null, fonte: 'b3' }))
      .filter(x => x.dataCom && x.valor > 0)
      .map(x => x.dataPag ? x : { ...x, pagEstimado: true });
    const ev = eventosDe(sup.stockDividends, e => classeIsin(e.isinCode) === obj.classe);
    if (mesclarJanela(obj, rec, ev)) { gravar(tk, obj); n++; }
  }
  return n;
}
async function atualizarFundoDia(tk) {
  const obj = lerArq(tk);
  if (!obj) return 0;
  const sigla = tk.slice(0, 4);
  const supD = await b3('fundsProxy/fundsCall/GetListedSupplementFunds', { cnpj: '', identifierFund: sigla, typeFund: 7 });
  const cd = supD?.cashDividends || [];
  if (!cd.length && !(supD?.stockDividends || []).length) return 0;
  const cont = {}; cd.forEach(x => { const k = x.isinCode || ''; cont[k] = (cont[k] || 0) + 1; });
  const isin = obj.isin || Object.entries(cont).sort((a, b) => b[1] - a[1])[0]?.[0];
  const vistos = new Set();
  const rec = cd.filter(x => (x.isinCode || '') === isin)
    .filter(x => { const k = [x.label, x.lastDatePrior, x.paymentDate, x.rate].join('|'); if (vistos.has(k)) return false; vistos.add(k); return true; })
    .map(x => ({ tipo: tipoDe(x.label), dataCom: iso(x.lastDatePrior), dataPag: iso(x.paymentDate) || null, valor: r8(num(x.rate)), aprovado: iso(x.approvedOn) || undefined, fonte: 'b3' }))
    .filter(x => x.dataCom && x.valor > 0)
    .map(x => x.dataPag ? x : { ...x, pagEstimado: true });
  const ev = eventosDe(supD?.stockDividends, e => !isin || !e.isinCode || e.isinCode === isin);
  if (mesclarJanela(obj, rec, ev)) { gravar(tk, obj); return 1; }
  return 0;
}
async function atualizarTudo(extra) {
  let ind = { ativos: {} };
  try { ind = JSON.parse(fs.readFileSync(path.join(SAIDA, 'indice.json'), 'utf8')); } catch {}
  const ativos = ind.ativos || {};
  const acoes = Object.keys(ativos).filter(t => ativos[t].t === 'acao');
  const fundos = Object.keys(ativos).filter(t => ativos[t].t !== 'acao');
  const porRaiz = {}; acoes.forEach(t => (porRaiz[t.slice(0, 4)] ||= []).push(t));
  let nA = 0, nF = 0, novos = 0, falhas = 0;
  for (const [raiz, tks] of Object.entries(porRaiz)) {
    if (tempoAcabou()) return true;
    try { nA += await atualizarEmpresa(raiz, tks); } catch (e) { falhas++; if (falhas < 30) relatorio.erros.push(`${raiz}: ${e.message}`); }
  }
  if (fundos.length) await sessaoFnet().catch(() => {});
  for (const tk of fundos) {
    if (tempoAcabou()) return true;
    try { nF += await atualizarFundoDia(tk); } catch (e) { falhas++; if (falhas < 30) relatorio.erros.push(`${tk}: ${e.message}`); }
  }
  // estreias: empresas e fundos negociados que ainda não estão na base
  try {
    const raizesBase = new Set(acoes.map(t => t.slice(0, 4)));
    for (const emp of await listarEmpresas()) {
      if (tempoAcabou()) return true;
      const raiz = String(emp.issuingCompany).toUpperCase();
      if (raizesBase.has(raiz) || estado.acoes[raiz]) continue; // já verificada na carga (com ou sem proventos)
      try { const k = await processarEmpresa(emp, null); estado.acoes[raiz] = HOJE; if (k) { novos += k; extra.push(`Ação nova na base: ${raiz}`); } } catch {}
    }
    const cvm = await listarFundos();
    for (const f of await listarFundosNegociados()) {
      if (tempoAcabou()) return true;
      if (ativos[f.ticker] || estado.fiis[f.sigla]) continue; // já verificado na carga
      const c = cvm.find(x => x.ticker === f.ticker);
      try { const k = await processarFundo(c ? { ...f, cnpj: c.cnpj } : f); estado.fiis[f.sigla] = HOJE; if (k) { novos += k; extra.push(`Fundo novo na base: ${f.ticker}`); } } catch {}
    }
  } catch (e) { relatorio.erros.push('estreias: ' + e.message); }
  extra.push(`Atualização diária: ações alteradas ${nA}, fundos alterados ${nF}, ativos novos ${novos}, falhas ${falhas}`);
  return false;
}

// ── execução ─────────────────────────────────────────────────────────────
// estado.json guarda o que a carga já processou, para continuar de onde parou
const ARQ_ESTADO = path.join(SAIDA, 'estado.json');
let estado = { acoes: {}, fiis: {} };
try { const e = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8')); if (e.v === 2) estado = { acoes: {}, fiis: {}, ...e }; } catch {} // v2: estados de versões anteriores são descartados
estado.v = 2;
const salvarEstado = () => { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(ARQ_ESTADO, JSON.stringify(estado)); };
const extra = [];
let interrompido = false;
try {
  if (MODO === 'teste' || MODO === 'acoes') {
    // out/2026: "REFAZER" no modo acoes = ações com data de pagamento estimada desde 2016 (com a leitura
    // nova das datas), somando os códigos escritos junto. Os já refeitos são pulados na rodada seguinte.
    const refazerA = MODO === 'acoes' && TICKERS.includes('REFAZER');
    let tksA = TICKERS.filter(t => t !== 'REFAZER');
    if (refazerA) {
      estado.refeitoAcoes = estado.refeitoAcoes || {};
      for (const arq of fs.readdirSync(SAIDA)) {
        if (!/\.json$/.test(arq) || arq === 'indice.json' || arq === 'estado.json') continue;
        const o = lerArq(arq.replace('.json', ''));
        if (!o || o.tipoAtivo !== 'acao') continue;
        if (o.proventos.some(p => p.pagEstimado && p.dataCom >= '2016-01-01') && !tksA.includes(o.ticker)) tksA.push(o.ticker);
      }
      tksA = tksA.filter(t => estado.refeitoAcoes[t] !== DATAS_ACOES);
      extra.push(`Ações a refazer com a leitura nova das datas: ${tksA.length}`);
    }
    const listaTk = tksA.length ? tksA.filter(t => !/^[A-Z]{4}11$/.test(t) || ['TAEE11','KLBN11','SAPR11','ALUP11','BPAC11','SANB11','ENGI11','TIET11','SULA11','BRBI11','IGTI11','CPLE11','ENEV11'].includes(t)) : (MODO === 'teste' ? BRAPI_GRATIS : []);
    if (refazerA && !listaTk.length) extra.push('Nenhuma ação a refazer.');
    let alvos = [];
    if (listaTk.length) {
      for (const r of [...new Set(listaTk.map(t => t.slice(0, 4)))]) { const e = await acharEmpresa(r); if (e) alvos.push(e); else relatorio.erros.push(r + ': empresa não encontrada na B3'); }
      if (MODO === 'teste') {
        try {
          const todas = await listarEmpresas();
          const porCampo = k => { const c = {}; todas.forEach(e => { const v = String(e[k] ?? '-'); c[v] = (c[v] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => v + ': ' + n).join(', '); };
          extra.push(`Empresas com ações na B3 (já filtradas): **${todas.length}**. Campos: ${todas[0] ? Object.keys(todas[0]).join(', ') : '-'}` + (todas[0] && 'market' in todas[0] ? `<br>Por mercado: ${porCampo('market')}` : '') + (todas[0] && 'segment' in todas[0] ? `<br>Por segmento: ${porCampo('segment')}` : '') + (todas[0] && 'type' in todas[0] ? `<br>Por tipo: ${porCampo('type')}` : ''));
        } catch (e) { extra.push('Lista de empresas da B3 falhou: ' + e.message); }
      }
    } else if (!refazerA) {
      alvos = await listarEmpresas();
      extra.push(`Empresas listadas na B3: ${alvos.length}`);
    }
    let n = 0, pulados = 0;
    for (const emp of alvos) {
      if (tempoAcabou()) { interrompido = true; break; }
      const raiz = String(emp.issuingCompany).toUpperCase();
      if (MODO === 'acoes' && !listaTk.length && estado.acoes[raiz]) { pulados++; continue; }
      try { n += await processarEmpresa(emp, listaTk.length ? listaTk : null); if (MODO === 'acoes' && !listaTk.length) estado.acoes[raiz] = HOJE; if (refazerA) { listaTk.filter(t => t.startsWith(raiz)).forEach(t => { estado.refeitoAcoes[t] = DATAS_ACOES; }); salvarEstado(); } }
      catch (e) { relatorio.erros.push(`${raiz}: ${e.message}`); }
    }
    extra.push(`Ações gravadas: ${n}` + (pulados ? ` (empresas já feitas em execuções anteriores: ${pulados})` : ''));
  }
  if (MODO === 'teste') {
    // Sondagem: ativos que saíram da bolsa, foram incorporados ou trocaram de código
    try {
      const canc = await listarCanceladas();
      extra.push(`Empresas canceladas (fora da bolsa) na B3: **${canc.length}**` + (canc[0] ? `. Campos: ${Object.keys(canc[0]).join(', ')}. Exemplos: ${canc.slice(0, 6).map(e => (e.issuingCompany || '?') + ' ' + (e.companyName || e.tradingName || '')).join(' · ')}` : ''));
      const linhas = [];
      for (const raiz of ['VVAR', 'BHIA', 'BRDT', 'VBBR', 'LAME', 'KROT', 'BIDI', 'CIEL', 'ENBR', 'SULA']) {
        const e = await acharEmpresa(raiz) || canc.find(x => String(x.issuingCompany).toUpperCase() === raiz);
        if (!e) { linhas.push(`${raiz}: não encontrada`); continue; }
        let n = 0, ult = '';
        try { const d = await b3('listedCompaniesProxy/CompanyCall/GetListedCashDividends', { language: 'pt-br', pageNumber: 1, pageSize: 120, tradingName: e.tradingName }); n = d?.page?.totalRecords ?? (d?.results || []).length; ult = (d?.results || []).map(x => iso(x.lastDatePriorEx)).sort().pop() || ''; } catch {}
        linhas.push(`${raiz}: ${e.cancelada ? 'cancelada' : 'listada'} "${e.tradingName}" (${e.companyName || ''}), proventos na B3: ${n}${ult ? ', último ' + ult : ''}`);
      }
      extra.push('Empresas que saíram ou trocaram de código:<br>' + linhas.join('<br>'));
    } catch (e) { extra.push('Sondagem de empresas canceladas falhou: ' + e.message); }
    try {
      const hist = fiisHistoricosCVM(), neg = await listarFundosNegociados();
      const fora = [...hist.values()].filter(f => !neg.some(n => n.ticker === f.ticker));
      const ex = ['BCFF', 'IRDM', 'HFOF', 'BTHF', 'RBRF', 'KISU'].map(g => hist.get(g)).filter(Boolean);
      extra.push(`FIIs nos informes da CVM desde 2016: **${hist.size}**, dos quais fora da bolsa hoje: **${fora.length}**. Exemplos: ${ex.map(f => `${f.ticker} CNPJ ${f.cnpj} (último informe ${f.ultimoAno})`).join(' · ')}`);
      for (const f of ex.filter(x => x.ticker === 'BCFF11' || x.ticker === 'IRDM11')) {
        await sessaoFnet();
        const r = await avisosFnet(f.cnpj, HOJE).catch(e => ({ docs: 'erro ' + e.message, itens: [] }));
        const datas = (r.itens || []).map(x => x.dataCom).sort();
        extra.push(`${f.ticker} no FundosNET: ${r.docs} avisos, ${(r.itens || []).length} rendimentos lidos, de ${datas[0] || '-'} a ${datas[datas.length - 1] || '-'}`);
      }
    } catch (e) { extra.push('Sondagem de FIIs antigos falhou: ' + e.message); }
  }
  if (MODO === 'teste' || MODO === 'fiis') {
    await sessaoFnet();
    let listaTk = TICKERS.length ? TICKERS.filter(t => /11$/.test(t)) : (MODO === 'teste' ? FUNDOS_TESTE : []);
    // "LIMPAR": remove rendimentos repetidos idênticos (mesmo tipo, data com, valor e pagamento) dos arquivos já gravados
    if (TICKERS.includes('LIMPAR')) {
      let arqs = 0, removidos = 0;
      for (const arq of fs.readdirSync(SAIDA)) {
        if (!/^[A-Z0-9]{4}11\.json$/.test(arq)) continue;
        const o = lerArq(arq.replace('.json', ''));
        if (!o || o.tipoAtivo === 'acao') continue;
        const vistos = new Set();
        const antes = o.proventos.length;
        o.proventos = o.proventos.filter(p => { const k = [p.tipo, p.dataCom, p.valor, p.dataPag || ''].join('|'); if (vistos.has(k)) return false; vistos.add(k); return true; });
        if (o.proventos.length < antes) { removidos += antes - o.proventos.length; arqs++; gravar(o.ticker, o); }
      }
      extra.push(`Limpeza: ${removidos} rendimentos repetidos removidos em ${arqs} fundos`);
      // sem outros códigos junto, não processa fundo nenhum (todos já constam como feitos)
    }
    // "REFAZER": fundos com rendimento repetido na mesma data com (avisos refeitos) ou com avisos que falharam
    const refazer = TICKERS.includes('REFAZER');
    if (refazer) {
      // out/2026: soma os códigos escritos junto (ex.: REFAZER,IRDM11,SNID11) e pula os já refeitos com a
      // leitura nova (v3), para a próxima rodada continuar de onde parou
      estado.refeito = estado.refeito || {};
      listaTk = listaTk.filter(t => estado.refeito[t] !== LEITURA_FNET);
      for (const arq of fs.readdirSync(SAIDA)) {
        if (!/^[A-Z0-9]{4}11\.json$/.test(arq)) continue;
        const o = lerArq(arq.replace('.json', ''));
        if (!o || o.tipoAtivo === 'acao') continue;
        const vistos = new Set(); let rep = false;
        for (const p of o.proventos) { if (p.fonte !== 'fundosnet') continue; const k = p.tipo + '|' + p.dataCom; if (vistos.has(k)) { rep = true; break; } vistos.add(k); }
        if ((rep || (o.avisosFalhos || 0) > 0) && estado.refeito[o.ticker] !== LEITURA_FNET && !listaTk.includes(o.ticker)) listaTk.push(o.ticker);
      }
      extra.push(`Fundos a refazer com a leitura nova (repetidos, com falhas ou pedidos): ${listaTk.length}` + (Object.values(estado.refeito).filter(v => v === LEITURA_FNET).length ? ` · já refeitos antes: ${Object.values(estado.refeito).filter(v => v === LEITURA_FNET).length}` : ''));
    }
    let fundos;
    if (listaTk.length) {
      fundos = listaTk.map(t => ({ sigla: t.slice(0, 4), ticker: t, typeFund: 7 }));
      try {
        const cvm = await listarFundos(), neg = await listarFundosNegociados();
        for (const f of fundos) {
          const c = cvm.find(x => x.ticker === f.ticker), n = neg.find(x => x.ticker === f.ticker);
          if (c) f.cnpj = c.cnpj;
          if (n) { f.nome = n.nome; if (n.tipoAtivo) f.tipoAtivo = n.tipoAtivo; }
        }
      } catch (e) { aviso('listas para os fundos escolhidos: ' + e.message); }
      if (MODO === 'teste') {
        try {
          const todos = await listarFundos();
          const ex = ['HGLG', 'MXRF', 'KNRI', 'XPML', 'BTLG'].map(g => todos.find(f => f.sigla === g)).filter(Boolean);
          extra.push(`FIIs na lista da CVM: **${todos.length}**. Conferência: ${ex.map(f => f.ticker + ' CNPJ ' + f.cnpj).join(' · ') || 'nenhum dos exemplos achado'}`);
          const neg = await listarFundosNegociados();
          const ag = neg.filter(f => f.tipoAtivo === 'fiagro'), inf = neg.filter(f => f.tipoAtivo === 'fiinfra');
          extra.push('Cadastro de fundos da CVM (plano B para Fiagros): ' + contarFiagrosCVM());
          extra.push(`Fundos negociados na B3 (arquivo de instrumentos): **${neg.length}** · Fiagros: **${ag.length}** (${ag.slice(0, 12).map(f => f.ticker).join(', ')}) · FI-Infra: **${inf.length}** (${inf.slice(0, 12).map(f => f.ticker).join(', ')})`);
        } catch (e) { extra.push('Listas de fundos falharam: ' + e.message); }
      }
    } else {
      // Só fundos negociados na bolsa (arquivo de instrumentos da B3). A lista da CVM, que inclui
      // fundos fora da bolsa, serve apenas para dar o CNPJ. Se o arquivo da B3 falhar, usa a da CVM.
      const cvm = await listarFundos();
      const negociados = await listarFundosNegociados();
      if (negociados.length) {
        fundos = negociados.map(f => { const c = cvm.find(x => x.ticker === f.ticker); return c ? { ...f, cnpj: c.cnpj } : f; });
        extra.push(`Fundos negociados na B3: ${negociados.length} (com CNPJ pela lista da CVM: ${fundos.filter(f => f.cnpj).length}; os demais pela B3 ou pelo cadastro da CVM)`);
      } else {
        fundos = cvm;
        extra.push(`Arquivo de instrumentos da B3 indisponível: usando a lista da CVM (${cvm.length}); fundos fora da bolsa ficam sem rendimentos da B3`);
      }
      // Fiagros, FI-Infra e outros fora da lista da CVM: dados/proventos/br/extras.json (lista de tickers)
      try {
        const extras = JSON.parse(fs.readFileSync(path.join(SAIDA, 'extras.json'), 'utf8'));
        for (const t of (Array.isArray(extras) ? extras : extras.tickers || [])) { const tk = String(t).toUpperCase().trim(); if (/^[A-Z]{4}11$/.test(tk) && !fundos.some(f => f.ticker === tk)) fundos.push({ sigla: tk.slice(0, 4), ticker: tk, typeFund: 7 }); }
      } catch {}
      extra.push(`Fundos listados na B3: ${fundos.length}`);
    }
    let n = 0, pulados = 0;
    for (const f of fundos) {
      if (tempoAcabou()) { interrompido = true; break; }
      const tk = f.ticker || f.sigla + '11';
      if (MODO === 'fiis' && !listaTk.length && estado.fiis[f.sigla]) { pulados++; continue; }
      try { n += await processarFundo(f); if (MODO === 'fiis' && !listaTk.length) estado.fiis[f.sigla] = HOJE; if (refazer) { estado.refeito[tk] = LEITURA_FNET; salvarEstado(); } }
      catch (e) { if (e.message === 'TEMPO') { interrompido = true; break; } relatorio.erros.push(`${tk}: ${e.message}`); }
    }
    extra.push(`FIIs gravados: ${n}` + (pulados ? ` (fundos já feitos em execuções anteriores: ${pulados})` : ''));
  }
} catch (e) {
  relatorio.erros.push('Falha geral: ' + e.message);
}
// ── diagnóstico (não grava nada) ─────────────────────────────────────────
let DIAG_CVM = null;
async function diagFundo(tk) {
  const sigla = tk.slice(0, 4);
  let cnpj = '';
  try { DIAG_CVM ||= await listarFundos(); const c = DIAG_CVM.find(x => x.ticker === tk); if (c) cnpj = c.cnpj; } catch {}
  if (!cnpj) { const h = (HISTORICO_FII ||= fiisHistoricosCVM()).get(sigla); if (h) cnpj = h.cnpj; }
  if (!cnpj) { for (const tf of [7, 34, 27, 26, 35, 36]) { const d = await detalheFundo(sigla, tf); const c = acharCnpj(d); if (c) { cnpj = c; break; } } }
  console.log(`\n===== DIAG ${tk} CNPJ ${cnpj || 'não achado'}`);
  if (!cnpj) return;
  await sessaoFnet();
  let docs = [];
  for (const tf of ['1', '', '11', '12', '13', '14', '2']) {
    const lista = []; let s = 0, total = Infinity;
    while (s < total && s < 3000) {
      const base = { d: '1', s: String(s), l: '100', 'o[0][dataEntrega]': 'desc', cnpjFundo: cnpj, idCategoriaDocumento: '14', idTipoDocumento: '41', idEspecieDocumento: '0' };
      if (tf) base.tipoFundo = tf;
      let d; try { d = await fnet(FN + 'pesquisarGerenciadorDocumentosDados?' + new URLSearchParams(base)); } catch { break; }
      total = d?.recordsFiltered ?? 0; const lote = d?.data || []; lista.push(...lote); if (!lote.length) break; s += 100;
    }
    if (lista.length) { docs = lista; console.log(`DIAG ${tk} tipoFundo ${tf || 'sem tipo'}: ${lista.length} avisos`); break; }
  }
  for (const doc of docs) {
    const meta = { id: doc.id, ref: doc.dataReferencia, entrega: doc.dataEntrega, situacao: doc.situacaoDocumento, status: doc.descricaoStatus ?? doc.status, especie: doc.especieDocumento ?? doc.descricaoEspecie, tipo: doc.tipoDocumento ?? doc.descricaoTipoDocumento, versao: doc.versao, modalidade: doc.descricaoModalidade ?? doc.modalidade };
    let xml = '';
    try {
      xml = String(await fnet(FN + 'downloadDocumento?id=' + doc.id, false) || '').trim();
      if (xml.startsWith('"')) xml = JSON.parse(xml);
      if (!xml.startsWith('<')) xml = Buffer.from(xml, 'base64').toString('utf8');
    } catch (e) { console.log('DIAG', tk, JSON.stringify(meta), 'download falhou', e.message); continue; }
    const cod = (xml.match(/<(CodNegociacao|CodigoNegociacao)\b[^>]*>([^<]*)</i) || [])[2] || '';
    const blocos = (xml.match(/<(Rendimento|Amortizacao)\b[^>]*>[\s\S]*?<\/\1>/gi) || []).map(b => {
      const campos = {}; for (const m of b.matchAll(/<([A-Za-z0-9_]+)\b[^>]*>([^<]*)<\/\1>/g)) campos[m[1]] = m[2].trim();
      return (/^<Amortizacao/i.test(b) ? 'AMORT ' : 'REND ') + JSON.stringify(campos);
    });
    const cab = (xml.replace(/<(Rendimento|Amortizacao)\b[\s\S]*?<\/\1>/gi, '').match(/<([A-Za-z0-9_]+)\b[^>]*>([^<]{1,80})<\/\1>/g) || []).slice(0, 25).join(' ');
    console.log('DIAG', tk, JSON.stringify(meta), 'cod', cod, '| blocos:', blocos.join(' || ') || '(nenhum)', '| cabecalho:', cab.replace(/\s+/g, ' ').slice(0, 900));
  }
}
async function diagEmpresa(tk) {
  const raiz = tk.slice(0, 4);
  console.log(`\n===== DIAG ${tk}`);
  let e = null;
  try { e = await acharEmpresa(raiz); } catch (x) { console.log('DIAG', tk, 'acharEmpresa falhou', x.message); }
  if (!e) { try { e = (await listarCanceladas()).find(x => String(x.issuingCompany).toUpperCase() === raiz) || null; if (e) e.cancelada = true; } catch {} }
  console.log('DIAG', tk, 'empresa:', e ? JSON.stringify(e).slice(0, 600) : 'não encontrada (nem na lista de canceladas)');
  if (!e) return;
  for (const nome of [...new Set([e.tradingName, e.companyName, raiz].filter(Boolean))]) {
    try {
      const d = await b3('listedCompaniesProxy/CompanyCall/GetListedCashDividends', { language: 'pt-br', pageNumber: 1, pageSize: 120, tradingName: nome });
      const r = d?.results || [];
      console.log('DIAG', tk, `histórico pelo nome "${nome}": ${d?.page?.totalRecords ?? r.length} registros; classes ${[...new Set(r.map(x => x.typeStock))].join(',')}; exemplos ${r.slice(0, 5).map(x => [x.corporateAction, x.typeStock, iso(x.lastDatePriorEx), x.valueCash].join(' ')).join(' · ')}`);
    } catch (x) { console.log('DIAG', tk, `histórico pelo nome "${nome}" falhou: ${x.message}`); }
  }
  try {
    const s = await b3('listedCompaniesProxy/CompanyCall/GetListedSupplementCompany', { issuingCompany: raiz, language: 'pt-br' });
    const o = Array.isArray(s) ? s[0] : s;
    console.log('DIAG', tk, `complemento: ${(o?.cashDividends || []).length} proventos recentes, ${(o?.stockDividends || []).length} eventos; ${JSON.stringify((o?.stockDividends || []).slice(0, 6)).slice(0, 700)}`);
  } catch (x) { console.log('DIAG', tk, 'complemento falhou', x.message); }
}
if (MODO === 'diagnostico') {
  for (const tk of TICKERS) {
    try { if (/11$/.test(tk) && !['TAEE11','KLBN11','SAPR11','ALUP11','BPAC11','SANB11','ENGI11','TIET11','SULA11','BRBI11','IGTI11','CPLE11','ENEV11'].includes(tk)) await diagFundo(tk); else await diagEmpresa(tk); }
    catch (e) { console.log('DIAG', tk, 'falhou', e.message); }
  }
  extra.push('Diagnóstico: o detalhe de cada ativo está no log do passo "Montar a base" (linhas DIAG). Nada foi gravado.');
}
if (MODO === 'atualizar') {
  try { interrompido = await atualizarTudo(extra); } catch (e) { relatorio.erros.push('Falha geral: ' + e.message); }
}
if (Object.keys(STATUS_FNET).length) extra.push('Situação dos avisos no FundosNET (situação|status|código): ' + Object.entries(STATUS_FNET).map(([k, v]) => k + ': ' + v).join(' · '));
if (interrompido) extra.push('**Parou no limite de tempo. Rode de novo no mesmo modo para continuar de onde parou.**');
else if (MODO !== 'teste' && MODO !== 'diagnostico') extra.push('**Concluído.**');
if (MODO === 'acoes' || MODO === 'fiis' || MODO === 'atualizar') salvarEstado();
if (MODO !== 'diagnostico') gravarIndice();
escreverResumo(extra);
