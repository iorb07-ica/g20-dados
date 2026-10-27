/* ============================================================
   b3-classificacao.js  ·  Classificação de ativos da B3
   Plataforma G20 — fonte ÚNICA de verdade.
   Carregado por: carteira.html e gestao-patrimonial.html
   ------------------------------------------------------------
   Tickers terminados em "11" podem ser 5 classes distintas:
     • Unit     → pacote de ações (ON+PN). Tratado como Ação.
     • ETF      → fundo de índice da B3 (BOVA11, IVVB11). Tratado como Ação.
     • FIAGRO   → Fundo de Inv. nas Cadeias Produtivas Agro.
     • FI-Infra → Fundo de Investimento em Infraestrutura.
     • FII      → Fundo de Investimento Imobiliário (PADRÃO).

   classificar11() decide pela lista. FII é o catch-all:
   só cai em FII o ticker "11" que não está em nenhuma lista.

   COMO MANTER: ao surgir fundo/Unit novo na B3, basta
   adicionar o ticker na lista correta abaixo. Nada mais muda.
   Listas compiladas da B3 / Funds Explorer / Mais Retorno — mai/2026.
   ============================================================ */

// --- UNITS (equity — classificadas como Ação) ---------------
var UNITS_CONHECIDAS = [
  'TAEE11','SANB11','BPAC11','KLBN11','ENGI11',
  'SAPR11','ALUP11','IGTI11','AZEV11',
  // out/2026: units que apareceram em importações (inclusive já deslistadas)
  'BIDI11','BRBI11','SULA11','CPLE11','TIET11','RNEW11','PPLA11'
];

// --- ETFs DA B3 (classificados como Ação, igual às outras importações) ---
// out/2026: sem esta lista, BOVA11, IVVB11, LFTS11 etc. caíam em FII.
var ETFS_B3_CONHECIDOS = [
  'BOVA11','BOVV11','BOVX11','BOVB11','BBOV11','PIBB11','BRAX11','ECOO11','SMAL11','SMAC11',
  'DIVO11','FIND11','MATB11','GOVE11','ISUS11','UTIL11','IVVB11','SPXI11','SPXB11','NASD11',
  'ACWI11','EURP11','WRLD11','XINA11','HASH11','QBTC11','ETHE11','BITH11','DEFI11','WEB311',
  'GOLD11','ALUG11','URET11','LFTS11','LFTB11','IMAB11','IRFM11','FIXA11','XFIX11','DEBB11',
  'USDB11','BNDX11','NUCL11','BIZD11','ARGE11','EUAT11','TECK11','DNAI11','AGRI11','CMDB11',
  // out/2026: mais ETFs da B3 (inclusive os de código com número no meio: WEB311, B5P211, 5GTK11)
  'BOVS11','XBOV11','BBSD11','QETH11','QDFI11','BITI11','CRPT11','NFTS11','META11','SOLH11',
  'XRPH11','GURU11','ESGB11','JOGO11','5GTK11','B5P211','IB5M11','IMBB11'
];

// --- FIAGRO -------------------------------------------------
var FIAGROS_CONHECIDOS = [
  'AAGR11','AAZQ11','AGRX11','AMAZ11','BBGO11','BRFT11','BTAG11',
  'BTRA11','CAFE11','CAUT11','CCFA11','CPTA11','CPTR11','CRAA11',
  'CTEM11','DCRA11','EGAF11','EQIA11','FARM11','FGAA11','FLEM11',
  'FTCA11','FZDA11','FZDB11','GCRA11','GRWA11','HCRA11','HGAG11',
  'IAAG11','IAGR11','IDGO11','JGPX11','KDOL11','KNCA11','KOPA11',
  'LAFI11','LSAG11','MAVC11','NAGR11','NCRA11','NELO11','NEXG11',
  'OIAG11','PLCA11','RURA11','RZAG11','RZEO11','SNAG11','SNFZ11',
  'STMB11','VCRA11','VGIA11','VHFA11','XPCA11'
];

// --- FI-INFRA -----------------------------------------------
var FIINFRAS_CONHECIDOS = [
  'BODB11','BDIF11','BRZD11','CPTI11','INFB11','INFA11','VANG11',
  'BIDB11','IRIF11','IFRI11','JMBI11','IFRA11','KDIF11','NUIF11',
  'OGIN11','RBIF11','RIFF11','CDII11','JURO11','SNID11','XPID11'
];

/**
 * Classifica um ticker no padrão "4 letras + 11".
 * Aceita com ou sem sufixo .SA, maiúsculo ou minúsculo.
 * Retorna: 'Acao' (Unit ou ETF) | 'FIAGRO' | 'FIInfra' | 'FII'
 */
function classificar11(t){
  t = String(t || '').replace(/\.SA$/i, '').replace(/F$/, '').toUpperCase();
  if(UNITS_CONHECIDAS.includes(t))    return 'Acao';
  if(ETFS_B3_CONHECIDOS.includes(t))  return 'Acao';
  if(FIAGROS_CONHECIDOS.includes(t))  return 'FIAGRO';
  if(FIINFRAS_CONHECIDOS.includes(t)) return 'FIInfra';
  return 'FII';
}

/* ------------------------------------------------------------
   out/2026: ETF da B3 como CLASSE própria.
   O lançamento continua gravado com tipo 'Acao' (é ativo em reais,
   cotado na B3; trocar o tipo mexeria na moeda). Na hora de agrupar
   (posições, filtros, composição) usa-se g20ClasseRV(), que devolve
   'ETF' para os ETFs brasileiros.
   ------------------------------------------------------------ */
function g20NormTk(t){ return String(t || '').toUpperCase().trim().replace(/\.SA$/i, ''); }

/* Ticker da B3 terminado em 11, inclusive com número no código (WEB311, B5P211, 5GTK11). */
function g20Eh11(t){ t = g20NormTk(t); return /^[A-Z0-9]{4}11$/.test(t) && /[A-Z]/.test(t.slice(0, 4)); }

function g20EhEtfBR(t){ return ETFS_B3_CONHECIDOS.indexOf(g20NormTk(t)) >= 0; }

/* Classe para exibição. ETF da B3 → 'ETF'; o resto fica como está. */
function g20ClasseRV(tipo, ticker){
  if (g20EhEtfBR(ticker) && (!tipo || tipo === 'Acao' || tipo === 'FII')) return 'ETF';
  return tipo;
}

try { window.g20Eh11 = g20Eh11; window.g20EhEtfBR = g20EhEtfBR; window.g20ClasseRV = g20ClasseRV; } catch(e){}
