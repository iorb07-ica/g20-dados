/* ============================================================================
   g20-rent.js · MOTOR DE RENTABILIDADE REAL DO G20 HUB  (G20Rent)
   ----------------------------------------------------------------------------
   27/10/2026: saiu de dentro do dashboard.html para este arquivo, sem nenhuma
   mudança no cálculo, para ser o motor ÚNICO de rentabilidade da plataforma:
   Dashboard, Minha Carteira (aba Gráficos) e, depois, Carteira G20. Mesma
   carteira = mesmo número em qualquer tela.

   Reconstrói a evolução REAL do patrimônio dia a dia e calcula rentabilidade
   TIME-WEIGHTED (TWR), que desconta aportes e resgates.
     • Ações / FIIs / Stocks / REITs / ETFs → preços históricos (proxy G20)
     • Cripto → cotado em USD e convertido a BRL
     • Renda Fixa → regra do papel (CDI/Selic/IPCA/IGPM/Prefixado), com IR e IOF
     • Câmbio USD/BRL → série histórica real (Banco Central)
     • Proventos recebidos entram como retorno no dia do pagamento

   Precisa estar carregado ANTES: g20-store.js (banco do aparelho) e, na página,
   window.G20Ind (índices). Usa também, quando existirem: G20RF, firebase,
   G20Live (Modo Live) e G20CorrigirPrecos (auditoria de preços do Dashboard).
   ============================================================================ */
(function (global) {
  'use strict';
  /* endereço do proxy (antes vinha da variável PROXY_URL do dashboard.html) */
  var PROXY_URL = 'https://g20-proxy.vercel.app';

  var CACHE_PREFIX = 'g20_histpx_';
  var CACHE_TTL    = 24 * 60 * 60 * 1000;
  var SERIE_KEY    = 'g20_serieReal';
  var SERIE_TTL    = 12 * 60 * 60 * 1000;

  /* out/2026 (abertura rápida): a série e os históricos de preço só mudam
     quando fecha um pregão novo. Antes valiam 12 h / 24 h fixas, e a primeira
     abertura de cada dia refazia tudo (13 s) mesmo num sábado, sem pregão
     nenhum. Agora valem até o próximo fechamento (dia útil, 20h de Brasília,
     depois do fechamento da B3 e de Nova York). Teto de 7 dias. */
  function _ultimoFechamento() {
    var BRT = 3 * 3600 * 1000, agora = Date.now();
    var d = new Date(agora - BRT);              // "relógio de Brasília" em UTC
    var alvo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0);
    for (var k = 0; k < 8; k++) {
      var dia = new Date(alvo).getUTCDay();
      if (dia !== 0 && dia !== 6 && alvo <= (agora - BRT)) return alvo + BRT;
      alvo -= 86400000;
    }
    return agora - 86400000;
  }
  function _serieFresca(at) {
    return !!at && at >= _ultimoFechamento() && (Date.now() - at) < 7 * 86400000;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     ASSINATURA DA CARTEIRA (lançamento 01/10)

     A série ficava guardada por 12 h e só era refeita quando um preço era
     corrigido. Aporte NOVO, edição ou exclusão não refaziam nada: o aluno
     lançava R$ 27 mil em MSFT na Minha Carteira, voltava ao dashboard e o
     card mostrava R$ 91 mil contra R$ 118 mil da Minha Carteira, com um
     "Desempenho" de -R$ 25.942 que nunca aconteceu. (A trava de 15% ainda
     descartava o valor ao vivo, que estava certo, por discordar da série velha.)

     Agora a série carrega a assinatura dos lançamentos que a geraram. Se os
     lançamentos mudaram, em qualquer aparelho, ela é descartada e refeita.
     Os campos são normalizados para a ordem das chaves não importar (o
     Firestore devolve as chaves em ordem alfabética; a Minha Carteira grava
     na ordem em que monta o objeto). */
  function _canon(o){
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(_canon).join(',') + ']';
    return '{' + Object.keys(o).sort().map(function(k){ return JSON.stringify(k) + ':' + _canon(o[k]); }).join(',') + '}';
  }
  /* 28/10/2026: FUNDOS E PREVIDÊNCIA (mc-fundos.js) entram na série. Lista guardada em g20_fundos. */
  function _lerFundos(){
    try { var l = JSON.parse(localStorage.getItem('g20_fundos') || '[]'); return Array.isArray(l) ? l.filter(function(f){ return f && f.chave; }) : []; } catch(e){ return []; }
  }
  function _sigFundos(fu){
    if (!fu || !fu.length) return '';
    return '#F' + _canon(fu.map(function(f){ return { k:f.chave, r:f.regime, p:f.prev || null, c:f.cotizAplic || null, cr:f.cotizResg || null, fo:f.forma || '', s:f.simples || null, m:f.movs || [] }; }));
  }
  function _sigCarteira(rvArr, rfArr, fuArr){
    try {
      var rv = Array.isArray(rvArr) ? rvArr : (JSON.parse(localStorage.getItem('g20_rvAportes') || '[]') || []);
      var rf = Array.isArray(rfArr) ? rfArr : (JSON.parse(localStorage.getItem('g20_rendaFixa') || '[]') || []);
      var fu = Array.isArray(fuArr) ? fuArr : _lerFundos();
      /* out/2026: os proventos recebidos entram na rentabilidade; provento novo
         também invalida a série guardada. */
      var pv = 0, pn = 0;
      try {
        (JSON.parse(localStorage.getItem('g20_rvDividendos') || '[]') || []).forEach(function(d){
          if (!d || d.isExDate) return; var v = parseFloat(d.total) || 0; if (v > 0) { pv += v; pn++; }
        });
      } catch(e){}
      var txt = 'v4|p' + pn + ':' + Math.round(pv * 100) + '|' + rv.map(function(a){
        return a ? [a.ticker, a.op, a.data, +a.qtd || 0, +a.preco || 0, a.moeda || '', +a.fxRate || 0, a.tipo || ''].join('~') : '';
      }).sort().join('|') + '#' + _canon(rf) + _sigFundos(fu);
      var h = 5381;
      for (var i = 0; i < txt.length; i++) h = ((h << 5) + h + txt.charCodeAt(i)) | 0;
      return txt.length + ':' + h;
    } catch (e) { return null; }
  }
  try { window.G20RentAssinatura = _sigCarteira; } catch(e){}   // diagnóstico no console

  /* ═══════════════════════════════════════════════════════════════════════
     SÉRIE PRONTA NA NUVEM (out/2026)

     O Sair apaga tudo do aparelho (segurança em computador compartilhado).
     No login seguinte a série era refeita do zero: ~13 s e uma rodada de
     históricos de preço pelo proxy da Vercel.

     Agora, toda série COMPLETA calculada vai também para o documento
     users/{uid}/dados/rentSerie (regra de só o dono), comprimida. No login,
     ela chega no MESMO snapshot que já traz os dados do usuário (zero leitura
     a mais) e é usada se valerem as MESMAS regras da cópia local: mesmo dono,
     mesma assinatura dos lançamentos, menos de 12 h, nenhum preço corrigido
     depois. Fora disso, recalcula como antes.
     Nunca vai para o localStorage; no aparelho só fica no IndexedDB, que o
     Sair esvazia.
     MOTOR_NUVEM acompanha o G20_SERIE_VER: mudou o cálculo, sobe os dois.
     ═══════════════════════════════════════════════════════════════════════ */
  var MOTOR_NUVEM = 8;   // 8 (24/10/2026): preços cobrindo o período inteiro (séries de 5 a 10 anos estavam cortadas em 5)
  var DOC_NUVEM = 'rentSerie';
  function _b64(u8){
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function _unb64(str){
    var bin = atob(str), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function _comprimir(txt){
    try {
      if (typeof CompressionStream === 'undefined' || !Blob.prototype.stream) return Promise.resolve({ gz: false, d: txt });
      var st = new Blob([txt]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(st).arrayBuffer().then(function(b){ return { gz: true, d: _b64(new Uint8Array(b)) }; });
    } catch (e) { return Promise.resolve({ gz: false, d: txt }); }
  }
  function _descomprimir(doc){
    try {
      if (!doc.gz) return Promise.resolve(JSON.parse(doc.d));
      if (typeof DecompressionStream === 'undefined' || !Blob.prototype.stream) return Promise.resolve(null);
      var st = new Blob([_unb64(doc.d)]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(st).text().then(function(t){ return JSON.parse(t); });
    } catch (e) { return Promise.resolve(null); }
  }
  function _refNuvem(uid){
    try {
      if (!uid || !window.firebase || !firebase.apps || !firebase.apps.length) return null;
      var cu = firebase.auth().currentUser;
      if (!cu || cu.uid !== uid) return null;               // só grava/usa na conta logada
      return firebase.firestore().collection('users').doc(uid).collection('dados').doc(DOC_NUVEM);
    } catch (e) { return null; }
  }

  function iso(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
  function parseISO(s) {
    var p = String(s).substring(0, 10).split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2]);
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function diasEntre(a, b) {
    return Math.max(0, Math.floor((parseISO(b) - parseISO(a)) / 86400000));
  }

  /* ------------------------------------------------- mapeamento de símbolos */
  function stooqSymbol(ticker, tipo) {
    var t = String(ticker || '').toUpperCase().trim();
    if (!t) return null;
    var tp = String(tipo || '').toUpperCase();
    if (tp === 'CRIPTO' || tp === 'RF') return null;
    t = t.replace(/-(USD|USDT|USDC|BRL)$/, '');
    if (/\d$/.test(t)) return t.toLowerCase() + '.sa';
    return t.toLowerCase() + '.us';
  }

  var COIN_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
    XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2',
    DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink', LTC: 'litecoin',
    UNI: 'uniswap', ATOM: 'cosmos', XLM: 'stellar', TRX: 'tron',
    NEAR: 'near', OP: 'optimism', ARB: 'arbitrum', USDT: 'tether', USDC: 'usd-coin'
  };
  function coinId(ticker) {
    var t = String(ticker || '').toUpperCase().trim().replace(/-(USD|USDT|USDC|BRL)$/, '');
    return COIN_IDS[t] || null;
  }

  /* ------------------------------------------------------------------ cache */
  /* ═══════════════════════════════════════════════════════════════════════
     CACHE DE HISTÓRICO POR ATIVO — IndexedDB (R51)

     Cada ativo guarda ~2.500 pontos diários. Numa carteira de 40 papéis são
     dezenas de chaves g20_histpx_* somando vários MB — sozinhas estouravam
     o localStorage e empurravam as outras gravações para o erro silencioso.

     Agora a persistência é no IndexedDB. Como as leituras aqui precisam ser
     síncronas (a reconstrução consulta o cache antes de decidir se busca na
     rede), mantemos um espelho em memória preenchido por uma pré-carga
     única no boot. Cache não encontrado significa apenas uma ida à rede a
     mais — nunca um número errado.
     ═══════════════════════════════════════════════════════════════════════ */
  var _histMem = {};              // espelho síncrono do IndexedDB
  var _histMemPronto = false;

  function _histIdxKey(chave){ return CACHE_PREFIX + chave; }

  /* Histórico guardado só é reaproveitado se chegar até perto de hoje. Um
     histórico parado (ex.: em 28/07) dentro do prazo de validade fazia o
     aparelho montar a série inteira com preços velhos. */
  function _histEmDia(c) {
    var p = c && c.pontos; if (!p || !p.length) return false;
    var d = String((p[p.length - 1] && (p[p.length - 1].d || p[p.length - 1].data)) || '').slice(0, 10);
    return !!d && (Date.now() - Date.parse(d + 'T12:00:00-03:00')) < 6 * 86400000;
  }
  /* Cripto negocia todo dia: mantém as 24 h. Bolsa: vale enquanto não fechar
     pregão novo depois de baixado (sábado de manhã não baixa nada de novo). */
  function _histValido(chave, c) {
    if (!c || !c.loadedAt || !c.pontos || !_histEmDia(c)) return false;
    if (/-USD$|^cg_/i.test(String(chave))) return (Date.now() - c.loadedAt) < CACHE_TTL;
    return (Date.now() - c.loadedAt) < CACHE_TTL || c.loadedAt >= _ultimoFechamento();
  }
  /* 24/10/2026: a cópia só serve se cobrir o período pedido (ou se já foi pedida
     desde antes dele: aí o ativo simplesmente começou a ser negociado depois) */
  function _histCobre(c, desde) {
    if (!desde || !c || !c.pontos || !c.pontos.length) return true;
    if (c.desde && c.desde <= desde) return true;
    var folga = iso(new Date(Date.parse(desde + 'T12:00:00Z') + 15 * 86400000));
    return c.pontos[0].d <= folga;
  }
  function lerCache(chave, desde) {
    var k = _histIdxKey(chave);
    // 1) espelho em memória (preenchido pela pré-carga)
    var m = _histMem[k];
    if (_histValido(chave, m) && _histCobre(m, desde)) return m.pontos;
    // 2) localStorage — versões anteriores gravavam aqui
    try {
      var c = JSON.parse(localStorage.getItem(k) || 'null');
      if (_histValido(chave, c) && _histCobre(c, desde)) {
        _histMem[k] = c;                       // promove para a memória
        return c.pontos;
      }
    } catch (e) {}
    return null;
  }

  /* out/2026: cópia vencida (passou das 24 h), mas ainda útil para completar
     só os dias que faltam. Até 30 dias. */
  function lerCacheVelho(chave) {
    var k = _histIdxKey(chave);
    var m = _histMem[k];
    if (!m || !m.pontos) { try { m = JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ m = null; } }
    if (m && m.loadedAt && m.pontos && m.pontos.length > 20 && (Date.now() - m.loadedAt) < 30 * 86400000) return m;
    return null;
  }
  /* Junta o histórico guardado com os dias novos. Recusa (devolve null) se os dias
     em comum não baterem: sinal de desdobramento ou ajuste retroativo no Yahoo,
     e aí o histórico inteiro precisa vir de novo. */
  function juntarHist(velhos, novos) {
    if (!velhos || !velhos.length || !novos || !novos.length) return null;
    var inicio = novos[0].d, mapa = {};
    novos.forEach(function(p){ mapa[p.d] = p.c; });
    var comuns = 0;
    for (var i = 0; i < velhos.length; i++) {
      var v = velhos[i]; if (v.d < inicio || mapa[v.d] == null) continue;
      comuns++;
      if (Math.abs(mapa[v.d] / v.c - 1) > 0.02) return null;
    }
    if (!comuns) return null;   // buraco entre o guardado e o novo
    return velhos.filter(function(p){ return p.d < inicio; }).concat(novos);
  }

  function gravarCache(chave, pontos, desde) {
    var k = _histIdxKey(chave);
    var payload = { loadedAt: Date.now(), pontos: pontos };
    if (desde) payload.desde = desde;   // de quando o histórico foi pedido (para saber se cobre o período)
    _histMem[k] = payload;
    if (window.G20Store) {
      try {
        G20Store.set(k, payload).catch(function(){});
        try { localStorage.removeItem(k); } catch(e){}   // libera a cota antiga
        return;
      } catch (e) {}
    }
    try { localStorage.setItem(k, JSON.stringify(payload)); } catch (e) {}
  }

  /* Pré-carga: traz do IndexedDB para o espelho em memória, uma vez.
     Roda no boot, antes de a reconstrução precisar dos preços. */
  (function preCarregarHist(){
    try {
      if (!window.G20Store || typeof G20Store.list !== 'function') { _histMemPronto = true; return; }
      G20Store.list(CACHE_PREFIX).then(function(res){
        var chaves = (res && res.keys) || [];
        if (!chaves.length) { _histMemPronto = true; return; }
        return Promise.all(chaves.map(function(k){
          return G20Store.get(k).then(function(v){ if (v && v.pontos) _histMem[k] = v; })
                               .catch(function(){});
        })).then(function(){
          _histMemPronto = true;
          console.log('[G20Rent] ' + Object.keys(_histMem).length +
                      ' históricos de preço recuperados do IndexedDB.');
        });
      }).catch(function(){ _histMemPronto = true; });
    } catch(e){ _histMemPronto = true; }
  })();

  /* Exposto para o G20DiagAtivos, que monta o índice de preços a partir
     daqui quando a reconstrução não rodou nesta sessão. */
  try { window._g20HistMem = _histMem; } catch(e){}
  function comTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms || 15000); })
    ]);
  }

  /* --------------------------------------------------- preços bolsa (Stooq) */
  function parseCSV(csv) {
    var linhas = csv.trim().split('\n');
    if (linhas.length < 2) return null;
    var head = linhas[0].toLowerCase().split(',');
    var iD = head.indexOf('date'), iC = head.indexOf('close');
    if (iD < 0 || iC < 0) return null;
    var out = [];
    for (var i = 1; i < linhas.length; i++) {
      var col = linhas[i].split(',');
      var v = parseFloat(col[iC]);
      if (col[iD] && isFinite(v) && v > 0) out.push({ d: col[iD], c: v });
    }
    out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    return out.length ? out : null;
  }

  /* Símbolo do Yahoo Finance: BR → PETR4.SA | US → AAPL | cripto → BTC-USD */
  function yahooSymbol(ticker, tipo) {
    var t = String(ticker || '').toUpperCase().trim().replace(/-(USD|USDT|USDC|BRL)$/, '');
    if (!t) return null;
    var tp = String(tipo || '').toUpperCase();
    if (tp === 'CRIPTO') return t + '-USD';
    if (/\d$/.test(t)) return t + '.SA';
    /* out/2026: Berkshire lançada como BRKB (ou BRK.B) não existe no Yahoo,
       que usa BRK-B. Dava 404 e a Berkshire ficava fora da série. */
    var CLASSE = { 'BRKB': 'BRK-B', 'BRKA': 'BRK-A', 'BFB': 'BF-B', 'BFA': 'BF-A' };
    if (CLASSE[t]) return CLASSE[t];
    if (/^[A-Z]{1,5}\.[AB]$/.test(t)) return t.replace('.', '-');
    return t;
  }

  /* Busca histórico via Yahoo através de proxy CORS.
     MOTIVO: chamadas diretas a Stooq/CoinGecko são bloqueadas por CORS no GitHub Pages
     (erro "No 'Access-Control-Allow-Origin' header"). O dashboard já contorna isso com
     corsproxy.io/allorigins para IBOV e S&P — usamos exatamente a mesma cascata aqui. */
  /* Tickers de empresas que saíram da bolsa (fusão, OPA, incorporação). O Yahoo devolve
     404 e o console enche de erro à toa — a posição já está zerada na carteira de qualquer
     forma, então é seguro pular.
     out/2026: IRDM11 entrou na lista. Foi incorporado pelo IRIM11 em 10/12/2025 e o
     histórico sumiu do Yahoo: o proxy devolvia 404 duas vezes em todo recálculo
     (duas chamadas à Vercel por nada). O resultado da série não muda, porque o 404
     já virava "sem preço" do mesmo jeito. */
  /* out/2026: BRK.B saiu daqui (a Berkshire continua na bolsa; estava na lista
     por engano). BPYU entrou: fechou capital em 26/07/2021. */
  var DELISTADOS = { 'SQIA3':1, 'CIO':1, 'STOR':1, 'SKX':1, 'STBP3':1, 'IRDM11':1, 'BPYU':1 };

  function buscarYahoo(sym, desdeISO) {
    if (!sym) return Promise.resolve(null);
    var _base = String(sym).replace('.SA','').toUpperCase();
    if (DELISTADOS[_base]) return Promise.resolve(null);
    var cached = lerCache(sym, desdeISO);
    if (cached) return Promise.resolve(cached);

    var anos = Math.max(1, Math.ceil(diasEntre(desdeISO, iso(new Date())) / 365)) + 1;
    /* 24/10/2026: o intervalo pedido precisa COBRIR o período. Antes, de 5 a 9 anos
       pedia '5y': com o primeiro aporte em 2020, os preços começavam em out/2021 e a
       série perdia o começo (MAX caiu de 8 anos para 5). Agora arredonda para cima. */
    var range = anos > 10 ? 'max' : (anos > 5 ? '10y' : (anos > 2 ? '5y' : (anos > 1 ? '2y' : '1y')));
    var yUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
               encodeURIComponent(sym) + '?range=' + range + '&interval=1d';

    function parseYahoo(data) {
      var r = data && data.chart && data.chart.result && data.chart.result[0];
      if (!r) throw new Error('sem chart.result');
      var ts = r.timestamp || [];
      var cl = (r.indicators && r.indicators.quote && r.indicators.quote[0] &&
                r.indicators.quote[0].close) || [];
      if (!ts.length || !cl.length) throw new Error('arrays vazios');
      var pontos = [];
      for (var i = 0; i < ts.length; i++) {
        var c = parseFloat(cl[i]);
        if (!isFinite(c) || c <= 0) continue;
        pontos.push({ d: new Date(ts[i] * 1000).toISOString().substring(0, 10), c: c });
      }
      if (!pontos.length) throw new Error('sem pontos');
      pontos.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
      return pontos;
    }

    /* Cascata: proxy G20 → corsproxy.io → allorigins → desiste.
       O proxy G20 vem primeiro porque é nosso: tem cache Redis de 6h e não
       some sem aviso. Em 31/08/26 os dois públicos caíram no mesmo dia e
       NENHUM ativo teve série — o dashboard inteiro caiu para estimativa. */
    var urlG20 = PROXY_URL + '/api/history?symbol=' + encodeURIComponent(sym) +
                 '&range=' + range + '&interval=1d';
    function tentar(url) {
      return comTimeout(fetch(url), 18000)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(parseYahoo);
    }

    /* Proxy G20 com uma segunda tentativa (rede móvel oscila). Os serviços
       públicos corsproxy/allorigins saíram: fora do ar desde 31/08/26, cada um
       consumia até 18s por ativo e fazia a reconstrução no celular não terminar. */
    function completo() {
      return tentar(urlG20)
        .catch(function () { return new Promise(function (ok) { setTimeout(ok, 1500); }).then(function () { return tentar(urlG20); }); })
        .then(function (pontos) { gravarCache(sym, pontos, desdeISO); return pontos; })
        .catch(function () { return null; });
    }

    /* out/2026: SÓ OS DIAS QUE FALTAM. Na 1ª abertura de cada dia o histórico
       guardado (24 h) vencia e o de cada ativo era baixado inteiro de novo, até
       10 anos por ativo. Se há uma cópia de até 30 dias que cobre o período,
       pede só o último mês (ou 3 meses) e emenda. Se os dias em comum não
       baterem (desdobramento, ajuste), cai no histórico completo como antes. */
    var velho = lerCacheVelho(sym);
    if (velho) {
      var limite10a = iso(new Date(Date.now() - 3650 * 86400000));
      var precisaDesde = desdeISO > limite10a ? desdeISO : limite10a;
      var cobre = velho.pontos[0].d <= iso(new Date(Date.parse(precisaDesde + 'T12:00:00Z') + 15 * 86400000));
      if (cobre) {
        var diasVelho = (Date.now() - velho.loadedAt) / 86400000;
        var urlCurta = PROXY_URL + '/api/history?symbol=' + encodeURIComponent(sym) +
                       '&range=' + (diasVelho <= 20 ? '1mo' : '3mo') + '&interval=1d';
        return tentar(urlCurta).then(function (novos) {
          var juntos = juntarHist(velho.pontos, novos);
          if (!juntos) throw new Error('não emenda');
          gravarCache(sym, juntos, velho.desde && velho.desde < desdeISO ? velho.desde : desdeISO);
          return juntos;
        }).catch(function () { return completo(); });
      }
    }
    return completo();
  }

  /* ------------------------------------------------ preços cripto (CoinGecko)
     Cotação em USD — mesmo padrão do resto da plataforma (BTC-USD / precoUsd).
     A conversão para BRL usa a MESMA série de câmbio dos ativos americanos. */
  function buscarCripto(ticker, desdeISO) {
    var id = coinId(ticker);
    if (!id) return Promise.resolve(null);
    var chave = 'cg_' + id;
    var cached = lerCache(chave);
    if (cached) return Promise.resolve(cached);

    var dias = Math.min(3650, Math.max(1, diasEntre(desdeISO, iso(new Date()))) + 1);
    var url = 'https://api.coingecko.com/api/v3/coins/' + id +
              '/market_chart?vs_currency=usd&days=' + dias + '&interval=daily';

    return comTimeout(fetch(url), 20000)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.prices || !j.prices.length) throw new Error('sem preços');
        var mapa = {};
        j.prices.forEach(function (par) {
          var v = par[1];
          if (isFinite(v) && v > 0) mapa[iso(new Date(par[0]))] = v;
        });
        var out = Object.keys(mapa).sort().map(function (d) { return { d: d, c: mapa[d] }; });
        if (!out.length) throw new Error('vazio');
        gravarCache(chave, out);
        return out;
      })
      .catch(function () { return null; });
  }

  /* ── Câmbio oficial do Banco Central (out/2026) ──
     out/2026 (v2): o pedido de 8 anos de uma vez falhava no BC e o proxy da Vercel
     ficava até ~25 s tentando (502), em TODO recálculo, porque nada era guardado.
     Agora:
       · pede ANO A ANO (pedidos pequenos passam no BC e o proxy guarda no Redis);
       · ano que já fechou é guardado de vez no aparelho (câmbio de 2019 não muda);
       · o ano atual é renovado no máximo a cada 12 h;
       · se o BC falhar, espera 6 h antes de tentar de novo (sem insistir a cada recálculo).
     São dados públicos do Banco Central, nada pessoal. Se faltar algum ano, o
     motor completa com o câmbio do Yahoo, como antes. */
  var FX_K = 'g20_fx_bcb_v2';
  function _fxLer(){ try { return JSON.parse(localStorage.getItem(FX_K) || 'null') || { anos: {}, falhouEm: 0 }; } catch(e){ return { anos: {}, falhouEm: 0 }; } }
  function _fxGravar(c){ try { localStorage.setItem(FX_K, JSON.stringify(c)); } catch(e){} }
  try { localStorage.removeItem('g20_fx_bcb_v1'); } catch(e){}
  function buscarCambioBCB(desdeISO) {
    var c = _fxLer(); c.anos = c.anos || {};
    var agora = Date.now(), hoje = new Date(), anoAtual = hoje.getFullYear();
    var ini = addDays(parseISO(desdeISO), -10);
    var lim = addDays(new Date(), -(365 * 10 - 5));   // o BC aceita no máximo 10 anos
    if (ini < lim) ini = lim;
    var anos = [];
    for (var y = ini.getFullYear(); y <= anoAtual; y++) anos.push(y);
    function valido(y){
      var a = c.anos[y];
      if (!a || !a.pts || !a.pts.length) return false;
      if (y < anoAtual) return !!a.fechado;
      return (agora - (a.em || 0)) < 12 * 3600 * 1000;
    }
    var faltam = anos.filter(function(y){ return !valido(y); });
    var emPausa = c.falhouEm && (agora - c.falhouEm) < 6 * 3600 * 1000;
    function juntar(){
      var out = [], iniISO = iso(ini);
      anos.forEach(function(y){ var a = c.anos[y]; if (a && a.pts) a.pts.forEach(function(p){ if (p.d >= iniISO) out.push(p); }); });
      out.sort(function(a, b){ return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
      if (!out.length) throw new Error('sem câmbio do BC');
      return out;
    }
    if (!faltam.length) return Promise.resolve().then(juntar);
    if (emPausa) {
      console.log('[G20Rent] câmbio do BC: em pausa após falha recente; usando o que já está guardado + Yahoo.');
      return Promise.resolve().then(juntar);
    }
    var _t0 = Date.now(), falhou = false;
    /* em sequência, para não disparar vários pedidos de uma vez no BC/proxy */
    return faltam.reduce(function(p, y){
      return p.then(function(){
        if (falhou) return;
        return _buscarCambioBCBAno(y, ini).then(function(pts){
          var fechado = y < anoAtual && agora > new Date(y + 1, 0, 6).getTime();   // BC já publicou o ano inteiro
          c.anos[y] = { pts: pts, em: agora, fechado: fechado };
        }, function(){ falhou = true; });
      });
    }, Promise.resolve()).then(function(){
      c.falhouEm = falhou ? agora : 0;
      _fxGravar(c);
      console.log('[G20Rent] câmbio do Banco Central: ' + (faltam.length) + ' ano(s) pedido(s) em ' + (Date.now() - _t0) + 'ms' +
                  (falhou ? ' (falhou; nova tentativa em 6 h)' : ''));
      return juntar();
    });
  }
  function _buscarCambioBCBAno(y, ini) {
    function br(d){ return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear(); }
    var de = new Date(y, 0, 1); if (de < ini) de = new Date(ini);
    var ate = new Date(y, 11, 31), hoje = new Date(); if (ate > hoje) ate = hoje;
    var url = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json&dataInicial=' + br(de) + '&dataFinal=' + br(ate);
    return comTimeout(fetch(url), 15000).then(function (r) { if (!r || !r.ok) throw new Error('BCB ' + (r && r.status)); return r.json(); })
      .then(function (arr) {
        var pts = [];
        (arr || []).forEach(function (x) {
          var p = String(x && x.data || '').split('/'), v = parseFloat(x && x.valor);
          if (p.length === 3 && v > 1) pts.push({ d: p[2] + '-' + p[1] + '-' + p[0], c: v });
        });
        if (!pts.length) throw new Error('BCB vazio');
        return pts;
      });
  }
  function mesclarCambio(yahoo, bcb) {
    var mapa = {};
    (yahoo || []).forEach(function (p) { mapa[p.d] = p.c; });
    var ultBcb = '';
    (bcb || []).forEach(function (p) { mapa[p.d] = p.c; if (p.d > ultBcb) ultBcb = p.d; });
    /* depois do último dia publicado pelo BC, só entra o Yahoo se for mais novo */
    return Object.keys(mapa).sort().map(function (d) { return { d: d, c: mapa[d] }; });
  }

  function indexar(pontos) {
    var mapa = {};
    for (var i = 0; i < pontos.length; i++) mapa[pontos[i].d] = pontos[i].c;
    return {
      em: function (dISO) {
        if (mapa[dISO] != null) return mapa[dISO];
        var d = parseISO(dISO);
        for (var k = 1; k <= 10; k++) {
          var alvo = iso(addDays(d, -k));
          if (mapa[alvo] != null) return mapa[alvo];
        }
        return null;
      },
      /* primeira cotação na data ou depois dela (até 30 dias) */
      primeiroDesde: function (dISO) {
        var d = parseISO(dISO);
        for (var k = 0; k <= 30; k++) {
          var alvo = iso(addDays(d, k));
          if (mapa[alvo] != null) return mapa[alvo];
        }
        return null;
      }
    };
  }
  function _primeiroPreco(idx, dISO) {
    if (!idx) return null;
    var p = idx.em(dISO);
    if (p > 0) return p;
    return idx.primeiroDesde ? idx.primeiroDesde(dISO) : null;
  }

  /* =====================================================================
     RENDA FIXA — valor do papel em QUALQUER data
     Replica a lógica já validada da Minha Carteira (_calcBruto + IR/IOF),
     parametrizada por data para reconstruir o histórico.
     ===================================================================== */
  var RF_ISENTO_IR  = { LCI:1, LCA:1, LIG:1, CRI:1, CRA:1, DEB:1, 'Debênture':1, 'Debenture':1 };
  var RF_ISENTO_IOF = { LCI:1, LCA:1, LIG:1, CRI:1, CRA:1, DEB:1, 'Debênture':1, 'Debenture':1 };

  function aliquotaIR(dias) {
    if (dias <= 180) return 22.5;
    if (dias <= 360) return 20;
    if (dias <= 720) return 17.5;
    return 15;
  }
  function aliquotaIOF(dias) {
    if (dias >= 30) return 0;
    var tab = [96,93,90,86,83,80,76,73,70,66,63,60,56,53,50,46,43,40,36,33,30,26,23,20,16,13,10,6,3,0];
    return tab[Math.max(0, Math.min(29, dias - 1))] || 0;
  }
  /* ═══════════════════════════════════════════════════════════════════════
     DIAS ÚTEIS — R51

     Antes: `dc * (252/365)`, uma estimativa que espalha os 252 dias úteis do
     ano por igual entre os 365 corridos. Cada dia virava 0,69 dia útil,
     inclusive sábado e domingo — e o CDB "rendia" no fim de semana. O card
     no modo "Apenas RF" mostrava +0,03% no domingo e o gráfico de 60 dias
     era uma reta perfeita, sem nenhum degrau.

     Agora contamos dia útil de verdade: fora sábados, domingos E feriados
     nacionais, incluindo os móveis. O CDI é apropriado exatamente assim —
     sexta paga o fim de semana, e a véspera de feriado paga o feriado.

     Os móveis dependem da Páscoa, que muda todo ano. Usamos o algoritmo de
     Meeus/Butcher para calculá-la e derivar carnaval (segunda e terça),
     Sexta-feira Santa e Corpus Christi.

     Incluímos também 24/12 e 31/12: não são feriados civis, mas o mercado
     financeiro não opera e não há apuração de CDI nessas datas.
     ═══════════════════════════════════════════════════════════════════════ */
  function _pascoa(ano) {
    // Meeus/Butcher — calendário gregoriano
    var a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
    var d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var mes = Math.floor((h + l - 7 * m + 114) / 31);
    var dia = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(ano, mes - 1, dia);
  }

  var _feriadosCache = {};
  function _feriadosDoAno(ano) {
    if (_feriadosCache[ano]) return _feriadosCache[ano];
    function fmt(dt) {
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') +
             '-' + String(dt.getDate()).padStart(2, '0');
    }
    function mais(dt, n) { var x = new Date(dt); x.setDate(x.getDate() + n); return x; }

    var p = _pascoa(ano);
    var set = {};
    var lista = [
      ano + '-01-01',            // Confraternização Universal
      ano + '-04-21',            // Tiradentes
      ano + '-05-01',            // Dia do Trabalho
      ano + '-09-07',            // Independência
      ano + '-10-12',            // Nossa Senhora Aparecida
      ano + '-11-02',            // Finados
      ano + '-11-15',            // Proclamação da República
      ano + '-12-24',            // véspera de Natal — mercado fechado
      ano + '-12-25',            // Natal
      ano + '-12-31',            // véspera de Ano-Novo — mercado fechado
      fmt(mais(p, -48)),         // segunda de carnaval
      fmt(mais(p, -47)),         // terça de carnaval
      fmt(mais(p, -2)),          // Sexta-feira Santa
      fmt(mais(p, 60))           // Corpus Christi
    ];

    /* Consciência Negra (20/11) só virou feriado NACIONAL com a Lei
       14.759/2023, valendo a partir de 2024. Antes disso era municipal ou
       estadual, e o mercado operava normalmente. Incluí-lo retroativamente
       tiraria um dia útil de cada ano desde 2018 e subestimaria o
       rendimento da renda fixa em todo o histórico. */
    if (ano >= 2024) lista.push(ano + '-11-20');

    lista.forEach(function (d) { set[d] = 1; });

    _feriadosCache[ano] = set;
    return set;
  }

  function _ehDiaUtil(dt) {
    var dw = dt.getDay();
    if (dw === 0 || dw === 6) return false;
    var s = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') +
            '-' + String(dt.getDate()).padStart(2, '0');
    return !_feriadosDoAno(dt.getFullYear())[s];
  }

  function diasUteisEstimados(dc) { return dc * (252 / 365); }   // legado

  /* Dias úteis entre duas datas (exclusivo no início, inclusivo no fim).

     Percorre semana a semana e desconta os feriados que caem em dia de
     semana — varrer dia a dia 8 anos de série, para cada papel e cada
     ponto, custaria caro demais. */
  var _duCache = {};
  function _diasUteisAte(iniISO, fimISO) {
    var ck = iniISO + '|' + fimISO;
    if (_duCache[ck] !== undefined) return _duCache[ck];

    var a = new Date(iniISO + 'T12:00:00'), b = new Date(fimISO + 'T12:00:00');
    if (!(b > a)) { _duCache[ck] = 0; return 0; }

    var ms = 86400000;
    var total = Math.round((b - a) / ms);
    var semanas = Math.floor(total / 7);
    var uteis = semanas * 5;
    var cur = new Date(a);
    cur.setDate(cur.getDate() + semanas * 7);
    var resto = total - semanas * 7;
    for (var i = 0; i < resto; i++) {
      cur.setDate(cur.getDate() + 1);
      var dw = cur.getDay();
      if (dw !== 0 && dw !== 6) uteis++;
    }

    // Desconta os feriados em dia de semana dentro da janela
    var y0 = a.getFullYear(), y1 = b.getFullYear();
    for (var y = y0; y <= y1; y++) {
      var fer = _feriadosDoAno(y);
      for (var ds in fer) {
        if (ds <= iniISO || ds > fimISO) continue;
        var fd = new Date(ds + 'T12:00:00');
        var w = fd.getDay();
        if (w !== 0 && w !== 6) uteis--;
      }
    }

    if (uteis < 0) uteis = 0;
    _duCache[ck] = uteis;
    return uteis;
  }

  function rfBruto(rf, dataRefISO, idx) {
    var vi = parseFloat(rf.valorInv || rf.valor || 0);
    var ini = String(rf.dataInicio || rf.data || '').substring(0, 10);
    if (!(vi > 0) || !ini || dataRefISO < ini) return 0;
    if (window.G20RF) return G20RF.bruto(Object.assign({}, rf, {valorInv: vi, dataInicio: ini}), dataRefISO).valor;
    var taxa = parseFloat(rf.taxa);
    if (!isFinite(taxa)) taxa = 0;
    var t = taxa / 100;
    var dc = diasEntre(ini, dataRefISO);
    if (dc <= 0) return vi;

    var ix = String(rf.indexador || 'CDI').toUpperCase();
    var fator = 1;
    /* CDI e Selic são apropriados por DIA ÚTIL — sexta paga o fim de semana
       inteiro, e o pagamento aparece na segunda. IPCA, IGP-M e prefixado são
       por dia corrido (base 365), então continuam com `dc`. */
    var du = _diasUteisAte(ini, dataRefISO);
    if (ix === 'CDI') {
      fator = Math.pow(1 + (idx.cdi || 0) / 100, t * du / 252);
    } else if (ix === 'SELIC') {
      fator = Math.pow(1 + (idx.selic || 0) / 100 + t, du / 252);
    } else if (ix === 'IPCA' || ix === 'IPCA+') {
      fator = Math.pow(1 + (idx.ipca || 0) / 100 + t, dc / 365);
    } else if (ix === 'IGPM' || ix === 'IGP-M') {
      fator = Math.pow(1 + (idx.igpm || 0) / 100 + t, dc / 365);
    } else if (ix === 'PREFIXADO') {
      fator = Math.pow(1 + t, dc / 365);
    }
    return vi * fator;
  }

  function rfLiquido(rf, dataRefISO, idx) {
    var vi = parseFloat(rf.valorInv || rf.valor || 0);
    var _ini0 = String(rf.dataInicio || rf.data || '').substring(0, 10);
    if (window.G20RF) { if (!(vi > 0) || !_ini0 || dataRefISO < _ini0) return 0; return G20RF.liquido(Object.assign({}, rf, {valorInv: vi, dataInicio: _ini0}), {ate: dataRefISO}).liquido; }
    var bruto = rfBruto(rf, dataRefISO, idx);
    if (!(bruto > 0)) return 0;
    var rend = bruto - vi;
    if (rend <= 0) return bruto;
    var ini = String(rf.dataInicio || rf.data || '').substring(0, 10);
    var dc = diasEntre(ini, dataRefISO);
    var tipo = rf.tipo || rf.subTipo || 'CDB';
    if (!RF_ISENTO_IOF[tipo]) rend -= rend * (aliquotaIOF(dc) / 100);
    if (!RF_ISENTO_IR[tipo])  rend -= rend * (aliquotaIR(dc) / 100);
    return vi + rend;
  }

  /* ------------------------------------------------------ eventos de aporte */
  function construirEventos(aportes) {
    /* Preço do aporte, tolerante a nome de campo.
       O cálculo antigo era `(+a.preco || 0)`: se o campo tivesse outro nome
       ou viesse vazio, o custo virava ZERO. A posição entrava na carteira
       mas o aporte não era contabilizado como fluxo — e o motor lia isso
       como LUCRO do dia. Um aporte de R$ 5 mil numa carteira de R$ 20 mil
       vira "+25% num dia", e esse ganho falso COMPÕE no retorno total. */
    var _semPreco = [];
    function _precoDoAporte(a){
      var p = (+a.preco) || (+a.precoMedio) || (+a.pm) ||
              (+a.precoUnit) || (+a.valorUnitario) || (+a.price) || 0;
      if (!(p > 0)) {
        // Último recurso: valor total dividido pela quantidade
        var tot = (+a.total) || (+a.valorTotal) || (+a.custoTotal) || 0;
        var q   = (+a.qtd) || 0;
        if (tot > 0 && q > 0) p = tot / q;
      }
      if (!(p > 0)) _semPreco.push(String(a.data||'').substring(0,10) + ' ' + (a.ticker||'?'));
      return p;
    }

    var _ev = (aportes || [])
      .filter(function (a) { return a && a.ticker && a.data && +a.qtd > 0; })
      .map(function (a) {
        var _px = 0;
        var venda = String(a.op || 'C').toUpperCase() === 'V';
        var sinal = venda ? -1 : 1;
        var tp = String(a.tipo || '').toUpperCase();
        var moeda = String(a.moeda || ((tp === 'CRIPTO' || tp === 'STOCK' || tp === 'REIT') ? 'USD' : 'BRL')).toUpperCase();
        return {
          d: String(a.data).substring(0, 10),
          /* Lançamento 01/10: antes era .split('-')[0], para tirar o "-USD" de
             cripto. Só que cortava também BRK-B (virava "BRK", que não existe no
             Yahoo): o histórico falhava, a Berkshire ficava fora da série e o
             dashboard mostrava ~R$ 26 mil a menos que a Minha Carteira. Agora
             só sai o sufixo de moeda. */
          ticker: String(a.ticker).toUpperCase().trim().replace(/-(USD|USDT|USDC|BRL)$/, ''),
          tipo: a.tipo || '',
          moeda: moeda,
          qtd: sinal * (+a.qtd),
          custo: sinal * (+a.qtd) * (_px = _precoDoAporte(a)),
          semPreco: !(_px > 0),  // out/2026: o motor usa a 1ª cotação disponível
          /* out/2026: MOVIMENTO DE CÓDIGO, não compra nem venda: troca de código,
             incorporação, conversão de BDR em ação (cadeia do Inter), saída de
             ativo que deixou a bolsa. Os lançamentos vão pelo CUSTO (é o que a
             Minha Carteira precisa para preço médio e IR), mas na rentabilidade
             o que importa é o valor: cada perna conta pelo valor de mercado do
             dia, e a perna que a série não consegue avaliar fica de fora. Assim
             o patrimônio só troca de nome, sem lucro nem prejuízo falso. */
          mov: !!(a._evento || a._interConv || /convers[aã]o\s*\(e\)/i.test(String(a.obs || '')))
        };
      })
      .sort(function (x, y) { return x.d < y.d ? -1 : (x.d > y.d ? 1 : 0); });

    if (_semPreco.length) {
      console.log('%c[G20Rent] ' + _semPreco.length + ' lançamento(s) sem preço — na rentabilidade, o custo ' +
        'vira a primeira cotação disponível do ativo: ' + _semPreco.slice(0,10).join(' | ') +
        (_semPreco.length > 10 ? ' …' : '') + '   (G20DiagAporte() detalha)',
        'color:#e8b84b');
    }
    try { window._g20AportesSemPreco = _semPreco; } catch(e){}
    return _ev;
  }

  /* ───────────────────────── FUNDOS E PREVIDÊNCIA (28/10/2026) ─────────────────────────
     Cada fundo vira, dia a dia: valor LÍQUIDO (o mesmo "se resgatasse hoje" da Minha Carteira) e
     fluxos (aplicação entra como aporte; resgate sai pelo valor que caiu na conta). O come-cotas não
     é fluxo: é imposto, reduz o patrimônio como na vida real.
     Cotas e IR vêm do motor dos fundos (g20-fundos-motor.js, carregado aqui se a página não tiver).
     O IR de cada dia é interpolado entre pontos exatos (semanais, em cada movimento e hoje), para
     não rodar o motor milhares de vezes. Hoje é exato: bate com o topo da Minha Carteira. */
  var _motorP = null;
  function _motorFundos(){
    if (window.G20Fundos) return Promise.resolve(window.G20Fundos);
    if (_motorP) return _motorP;
    _motorP = new Promise(function(ok){
      try {
        var sc = document.createElement('script'); sc.src = 'assets/g20-fundos-motor.js?v=1';
        sc.onload = function(){ ok(window.G20Fundos || null); }; sc.onerror = function(){ _motorP = null; ok(null); };
        document.head.appendChild(sc);
      } catch(e){ ok(null); }
    });
    return _motorP;
  }
  function _fundoMotor(f){
    return { regime:f.regime, prev:f.prev, cotizAplic:f.cotizAplic, cotizResg:f.cotizResg, liqResg:f.liqResg, forma:f.forma, simples:f.simples, cfg:f.cfg, movs:f.movs || [] };
  }
  function _inicioFundo(f){
    var d = null;
    (f.movs || []).forEach(function(m){ if (m && m.data && (!d || m.data < d)) d = String(m.data).slice(0, 10); });
    if (f.forma === 'C' && f.simples && f.simples.data && (!d || f.simples.data < d)) d = f.simples.data;
    return d;
  }
  function _prepFundos(lista, hoje){
    if (!lista || !lista.length) return Promise.resolve(null);
    return _motorFundos().then(function(M){
      if (!M) return null;
      return Promise.all(lista.map(function(f){
        return M.carregarCotas(f.chave).then(function(c){ return _diasDoFundo(M, f, c.cotaDe, hoje); }).catch(function(){ return null; });
      })).then(function(arr){
        var dias = {}, n = 0;
        arr.forEach(function(m){
          if (!m) return; n++;
          Object.keys(m).forEach(function(d){ var o = dias[d] || (dias[d] = { v:0, fl:0 }); o.v += m[d].v; o.fl += m[d].fl; });
        });
        return n ? dias : null;
      });
    });
  }
  function _diasDoFundo(M, f, cotaDe, hoje){
    var fm = _fundoMotor(f), A = M.datas.addDias;
    var R = M.processar(fm, { cotaDe:cotaDe, hoje:hoje });
    var evs = (R.eventos || []).filter(function(e){ return e.tipo !== 'resg' || !e.pendente; }).map(function(e){ return { d:e.dataCotiz || e.data, e:e }; })
      .filter(function(x){ return x.d && x.d <= hoje; }).sort(function(a, b){ return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    var ini = null, q = 0;
    if (f.forma === 'C' && f.simples && f.simples.data) {
      var cs = cotaDe(f.simples.data);
      if (cs) { ini = f.simples.data; q = f.simples.cotas ? +f.simples.cotas : (+f.simples.saldo || 0) / cs; }
      evs = evs.filter(function(x){ return x.d > f.simples.data || x.e.tipo === 'aplic' || x.e.tipo === 'resg'; });
    }
    if (evs.length && (!ini || evs[0].d < ini)) ini = evs[0].d;
    if (!ini) return null;
    /* IR exato em pontos de apoio: toda semana, véspera e dia de cada movimento, e hoje */
    var ap = {}, d;
    for (d = ini; d <= hoje; d = A(d, 7)) ap[d] = 1;
    evs.forEach(function(x){ ap[x.d] = 1; ap[A(x.d, -1)] = 1; });
    ap[hoje] = 1;
    var pts = Object.keys(ap).filter(function(x){ return x >= ini && x <= hoje; }).sort().map(function(x){
      var P = M.processar(fm, { cotaDe:cotaDe, hoje:x }).posicao || {};
      return [x, (P.cotas > 0 && P.bruto > 0) ? Math.max(0, P.bruto - (P.liquido || P.bruto)) : 0];
    });
    var out = {}, i = 0, k = 0, cIni = (f.forma === 'C' && f.simples) ? f.simples.data : null;
    for (d = ini; d <= hoje; d = A(d, 1)) {
      var fl = 0;
      if (cIni && d === cIni) fl += -1;   /* marca: entrada do cadastro rápido (o fluxo é o próprio valor do dia) */
      while (i < evs.length && evs[i].d <= d) {
        var e = evs[i++].e;
        if (e.tipo === 'aplic') { q += +e.cotas || 0; fl += +e.valor || 0; }
        else if (e.tipo === 'resg') { q -= +e.cotas || 0; fl -= Math.max(0, (+e.bruto || 0) - (+e.ir || 0) - (+e.iof || 0)); }
        else if (e.tipo === 'come') q -= +e.cotas || 0;
        else if (e.tipo === 'ajuste') q += +e.cotas || 0;
        else if (e.tipo === 'incorp') q *= +e.fator || 1;
      }
      var c = cotaDe(d); if (!c) continue;
      while (k < pts.length - 1 && pts[k + 1][0] <= d) k++;
      var ir = pts[k][1];
      if (k < pts.length - 1 && pts[k][0] < d) {
        var a0 = Date.parse(pts[k][0]), a1 = Date.parse(pts[k + 1][0]), t = (Date.parse(d) - a0) / Math.max(1, a1 - a0);
        ir = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t;
      }
      var v = Math.max(0, q * c - ir);
      if (fl < 0 && cIni && d === cIni) fl = fl + 1 + v;   /* cadastro rápido: o saldo informado entra como aporte, sem lucro falso */
      out[d] = { v:v, fl:fl };
    }
    return out;
  }

  /* ----------------------------------------------------------------- TWR */
  function twr(serie) {
    var fator = 1;
    for (var i = 1; i < serie.length; i++) {
      var vIni = serie[i - 1].patrimonio;
      var vFim = serie[i].patrimonio;
      var fluxo = serie[i].fluxo || 0;
      if (!(vIni > 0)) continue;
      var r = (vFim + (serie[i].prov || 0) - fluxo - vIni) / vIni;   // out/2026: provento recebido é retorno
      if (isFinite(r)) fator *= (1 + r);
    }
    return (fator - 1) * 100;
  }

  /* ----------------------------------------------------------------- API */
  var API = {
    lerFundos: _lerFundos,
    calcular: function (opts) {
      opts = opts || {};
      var fuLista = Array.isArray(opts.fundos) ? opts.fundos.filter(function(f){ return f && f.chave && _inicioFundo(f); }) : [];   // 28/10/2026
      var _sigIni = _sigCarteira(opts.aportes || [], opts.rendaFixa || [], fuLista);   // dos dados USADOS
      var eventos = construirEventos(opts.aportes);
      /* ── PROVENTOS RECEBIDOS (out/2026) ─────────────────────────────────────
         Dividendos, JCP e rendimentos pagos entram como retorno no dia do
         pagamento (como no Ibovespa, que é um índice com proventos). Não mexem
         no patrimônio nem nos aportes: ficam no campo `prov` de cada dia, em R$
         (provento em dólar convertido pelo câmbio do dia). Cripto não paga. */
      var _provLista = Array.isArray(opts.proventos) ? opts.proventos : [];
      var _provDia = {};
      (function(){
        var hojeP = iso(new Date()), vistos = {};
        var moedaTk = {};
        (opts.aportes || []).forEach(function(a){
          if (!a || !a.ticker) return;
          var tp = String(a.tipo || '').toUpperCase();
          moedaTk[String(a.ticker).toUpperCase()] = a.moeda || ((tp === 'STOCK' || tp === 'REIT' || tp === 'ETF' || tp === 'UCITS' || tp === 'CRIPTO') ? 'USD' : 'BRL');
          if (tp === 'CRIPTO') moedaTk['__cripto_' + String(a.ticker).toUpperCase()] = 1;
        });
        _provLista.forEach(function(d){
          if (!d || d.isExDate || !d.ticker || !d.fonte) return;
          var tk = String(d.ticker).toUpperCase().replace(/\.SA$/, '');
          if (moedaTk['__cripto_' + tk]) return;
          var dt = String(d.data || '').substring(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || dt > hojeP) return;
          var total = parseFloat(d.total);
          if (!(total > 0)) total = (parseFloat(d.valorCota) || 0) * (parseFloat(d.qtd) || 0);
          if (!(total > 0)) return;
          var chave = tk + '|' + dt + '|' + (Math.round((parseFloat(d.valorCota) || total) * 1e6));
          if (vistos[chave]) return; vistos[chave] = 1;
          var moeda = d.moeda || moedaTk[tk] || (/\d$/.test(tk) ? 'BRL' : 'USD');
          var o = _provDia[dt] || (_provDia[dt] = { brl: 0, usd: 0 });
          if (moeda === 'USD') o.usd += total; else o.brl += total;
        });
      })();
      var rfLista = (opts.rendaFixa || []).filter(function (r) {
        return r && (parseFloat(r.valorInv || r.valor || 0) > 0) && (r.dataInicio || r.data);
      });
      var idx = opts.indices || { cdi: G20Ind.get('cdi',13.65), selic: G20Ind.get('selic',13.75), ipca: G20Ind.get('ipca',5.32), igpm: G20Ind.get('igpm',4.39) };
      if (!eventos.length && !rfLista.length && !fuLista.length) return Promise.resolve(null);

      var datas = [];
      if (eventos.length) datas.push(eventos[0].d);
      rfLista.forEach(function (r) { datas.push(String(r.dataInicio || r.data).substring(0, 10)); });
      fuLista.forEach(function (f) { datas.push(_inicioFundo(f)); });
      datas.sort();
      var desde = opts.desde || datas[0];
      var hoje = iso(new Date());

      /* 28/10/2026: a moeda em que o ATIVO É COTADO (para avaliar a posição) não é a moeda em
         que cada compra foi lançada. Antes valia a do último lançamento: na Carteira G20 as compras
         de bitcoin foram lançadas em reais (preço em R$, com o câmbio do dia), e o motor passava a
         ler a cotação do BTC-USD como se fosse em reais, avaliando a posição em cerca de 1/5 do
         valor. A rentabilidade de 2019 a 2021 (quando o bitcoin mais subiu) saía muito menor.
         Agora: código da B3 (termina em número) é cotado em reais; Stock, REIT, ETF de fora, UCITs
         e cripto são cotados em dólar; o resto segue o lançamento. O CUSTO de cada compra continua
         na moeda em que ela foi lançada (ev.moeda), como antes. */
      function moedaCotacao(e) {
        var t = String(e.ticker || '').toUpperCase(), tp = String(e.tipo || '').toUpperCase();
        if (/\d$/.test(t)) return 'BRL';
        if (tp === 'CRIPTO' || tp === 'STOCK' || tp === 'REIT' || tp === 'ETF' || tp === 'UCITS') return 'USD';
        return e.moeda;
      }
      var mapaAtivos = {};
      eventos.forEach(function (e) {
        mapaAtivos[e.ticker] = {
          cripto: String(e.tipo).toUpperCase() === 'CRIPTO',
          moeda: moedaCotacao(e), tipo: e.tipo
        };
      });

      // Todos via Yahoo + proxy CORS (bolsa, cripto e câmbio na mesma cascata).
      // CONCORRÊNCIA LIMITADA: carteiras grandes têm 50-100 ativos; disparar tudo de uma vez
      // derruba o proxy público. Processa em lotes pequenos, em sequência.
      var tickersLista = Object.keys(mapaAtivos);
      var resultados = [];

      function processarLote(inicio) {
        var lote = tickersLista.slice(inicio, inicio + 6);
        if (!lote.length) return Promise.resolve();
        return Promise.all(lote.map(function (tk) {
          return buscarYahoo(yahooSymbol(tk, mapaAtivos[tk].tipo), desde)
            .then(function (pontos) {
              /* 28/10/2026: ativo que saiu da bolsa não tem mais histórico no Yahoo. Quem chama pode
                 mandar o histórico guardado (opts.precosExtra, ex.: o mensal da Carteira G20); sem ele
                 o ativo ficava sem preço enquanto estava na carteira, a "cobertura" caía e o motor
                 ignorava esses dias (a Carteira G20 de 2019 a 2021 tinha SQIA3, STBP3, STOR, CIO...). */
              /* Também quando o histórico diário COMEÇA DEPOIS da primeira compra (fundo que mudou de
                 código, histórico antigo que sumiu do Yahoo): os dias que faltam no começo vêm do
                 histórico guardado. Exemplo: XPLG11, TVRI11 e BTHF11 comprados em 09/12/2019 não tinham
                 preço diário naquele mês e subiram de 9% a 16%; o ganho ficava de fora. */
              var ex = opts.precosExtra && opts.precosExtra[tk];
              if (ex && ex.length) {
                if (!pontos || !pontos.length) pontos = ex.slice();
                else if (ex[0].d < pontos[0].d) {
                  var ini = pontos[0].d, antes = ex.filter(function (p) { return p.d < ini; });
                  if (antes.length) pontos = antes.concat(pontos);
                }
              }
              resultados.push({ ticker: tk, pontos: pontos });
            });
        })).then(function () { return processarLote(inicio + 6); });
      }

      var jobs = buscarYahoo('USDBRL=X', desde)
        .then(function (p) {
          /* out/2026: o câmbio do Yahoo atrasa e repete dias (em 05/10/2026 o
             dólar caiu 4,12%, para R$ 5,00, e a série seguia com 5,22). Agora o
             dólar de cada dia vem do Banco Central (série 1, dólar comercial de
             venda) e o Yahoo só cobre os dias que o BC ainda não publicou. */
          return buscarCambioBCB(desde).then(function (b) { return mesclarCambio(p, b); }, function () { return p; });
        })
        .then(function (p) { resultados.push({ ticker: '__USDBRL__', pontos: p }); })
        .then(function () { return processarLote(0); })
        .then(function () { return _prepFundos(fuLista, hoje).then(function (fd) { _fuDias = fd; }, function () {}); })
        .then(function () { return resultados; });
      var _fuDias = null;

      return jobs.then(function (res) {
        var precos = {}, cambio = null;
        res.forEach(function (r) {
          if (!r.pontos) return;
          if (r.ticker === '__USDBRL__') cambio = indexar(r.pontos);
          else precos[r.ticker] = indexar(r.pontos);
        });
        /* Expõe as séries de preço para diagnóstico. Elas já foram baixadas
           para a reconstrução; reaproveitar evita nova rodada de rede e
           garante que o diagnóstico compare contra EXATAMENTE os mesmos
           preços que o motor usou. */
        try { window._g20Precos = precos; window._g20Cambio = cambio; } catch(e){}

        /* Com os preços em mãos, audita os aportes e corrige distorções de
           desdobramento automaticamente. Roda uma vez por sessão: o aluno
           não deve precisar saber que splits existem, muito menos ajustar
           preço na mão. */
        try {
          if (!window._g20PrecosAuditados && typeof window.G20CorrigirPrecos === 'function') {
            window._g20PrecosAuditados = true;
            setTimeout(function(){
              try {
                var r = window.G20CorrigirPrecos(true);
                if (r && r.length) {
                  console.warn('%c[G20 preço] Aportes corrigidos automaticamente. ' +
                    'A rentabilidade será recalculada no próximo carregamento.',
                    'color:#e8b84b;font-weight:bold');
                }
              } catch(e){ console.warn('[G20 preço] auditoria falhou:', e && e.message); }
            }, 1200);
          }
        } catch(e){}

        var serie = [], pos = {}, ei = 0;
        var cursor = parseISO(desde), fim = parseISO(hoje);

        var _fxUltimo = 0, _fxFalhas = [], _fxSemNada = 0;
        window._g20FxDiag = { falhas: _fxFalhas, semNada: 0 };
        while (cursor <= fim) {
          var dISO = iso(cursor);
          var fluxoDia = 0, fluxoRVdia = 0;
          /* CÂMBIO DO DIA.
             Antes: `fx || 5` — se faltasse cotação, usava 5,00 em silêncio.
             Em 2019 o dólar valia ~3,85: cair para 5,00 inflava os ativos em
             dólar em ~30% naquele dia, criando um salto que parecia mercado.
             E a métrica de "cobertura" não pegava isso, porque ela só conta
             preço de ATIVO, não câmbio.
             Agora: carry-forward sem teto (guarda o último câmbio conhecido)
             e registro de quando faltou, para não haver falha silenciosa. */
          var fxDia = cambio ? cambio.em(dISO) : null;
          if (fxDia > 0) { _fxUltimo = fxDia; }
          else if (_fxUltimo > 0) { fxDia = _fxUltimo; _fxFalhas.push(dISO); }
          var fx = fxDia;

          while (ei < eventos.length && eventos[ei].d <= dISO) {
            var ev = eventos[ei];
            pos[ev.ticker] = (pos[ev.ticker] || 0) + ev.qtd;
            var custo = ev.custo;
            /* out/2026: ativo SEM cotação nenhuma (saiu da bolsa e o histórico
               sumiu, ex.: CIO, BPYU) vale zero na série inteira. A compra entrava
               como aporte sem o valor aparecer (prejuízo falso) e a saída como
               resgate sem o valor sair (lucro falso). Fica fora dos dois lados. */
            if (!precos[ev.ticker]) { ei++; continue; }
            /* Lançamento sem preço (ex.: INTR em 22/06/2022, vindo da migração do
               Inter para a Nasdaq, que só começou a negociar em 23/06): o custo
               passa a ser a primeira cotação disponível a partir da data. Antes
               era zero, e a posição inteira virava lucro no dia. */
            if (ev.mov) {
              var _pxM = ev.qtd > 0 ? _primeiroPreco(precos[ev.ticker], dISO) : precos[ev.ticker].em(dISO);
              if (!(_pxM > 0)) { ei++; continue; }   // perna sem avaliação: fora dos dois lados
              custo = ev.qtd * _pxM;
            } else if (ev.semPreco) {
              var _pxE = _primeiroPreco(precos[ev.ticker], dISO);
              if (_pxE > 0) custo = ev.qtd * _pxE;
            }
            if (ev.moeda === 'USD') { if (!(fx > 0)) _fxSemNada++; custo = custo * (fx > 0 ? fx : 5); }
            fluxoDia += custo;
            fluxoRVdia += custo;      // separado, para variação por classe
            ei++;
          }

          // Renda variável + cripto (a mercado)
          var valRV = 0, valUSD = 0, avaliados = 0, totalAtivos = 0;
          Object.keys(pos).forEach(function (tk) {
            var q = pos[tk];
            if (!(q > 0)) return;
            totalAtivos++;
            var px = precos[tk] ? precos[tk].em(dISO) : null;
            if (px == null) return;
            avaliados++;
            var v = q * px;
            if (mapaAtivos[tk] && mapaAtivos[tk].moeda === 'USD') { valUSD += v; if (!(fx > 0)) _fxSemNada++; v = v * (fx > 0 ? fx : 5); }
            valRV += v;
          });

          // Renda fixa (pela regra do papel, nesta data)
          var valRF = 0, aporteRFdia = 0;
          rfLista.forEach(function (rf) {
            var ini = String(rf.dataInicio || rf.data).substring(0, 10);
            if (dISO < ini) return;
            if (dISO === ini) aporteRFdia += parseFloat(rf.valorInv || rf.valor || 0);
            valRF += rfLiquido(rf, dISO, idx);
          });
          fluxoDia += aporteRFdia;

          /* Fundos e Previdência (28/10/2026) */
          var valFU = 0, fluxoFUdia = 0, _fd = _fuDias && _fuDias[dISO];
          if (_fd) { valFU = _fd.v; fluxoFUdia = _fd.fl; fluxoDia += fluxoFUdia; }

          var patrimonio = valRV + valRF + valFU;
          var cobertura = totalAtivos ? (avaliados / totalAtivos) : 1;
          var _pd = _provDia[dISO], provDia = 0;
          if (_pd) provDia = _pd.brl + _pd.usd * (fx > 0 ? fx : 5);

          /* ═══════════════════════════════════════════════════════════════
             COBERTURA — quantos dos ativos em carteira tinham preço no dia.

             Um ponto com cobertura 0,5 significa que METADE da carteira não
             foi avaliada: o patrimônio daquele dia sai pela metade. No dia
             seguinte, se o preço aparece, ele "dobra" — e o TWR lê isso como
             +100% de mercado.

             É o que acontece nos primeiros anos: os históricos vêm do Yahoo
             com janela limitada, então ativos comprados em 2018 só têm preço
             a partir de ~2021. A série existe (patrimônio > 0), mas está
             subavaliada, e a recuperação da cobertura vira retorno fantasma.

             Foi isso que produziu +404% no "Max" contra +97% no 5A, com um
             ganho em dinheiro de apenas R$ 209 mil. Os três anos iniciais
             não descreviam mercado; descreviam preços chegando.

             Marcamos o ponto para que o TWR saiba ignorar as transições.
             ═══════════════════════════════════════════════════════════════ */
          if (patrimonio > 0 && (totalAtivos === 0 || cobertura >= 0.5)) {
            try { window._g20FxDiag.semNada = _fxSemNada; } catch(e){}
          serie.push({
              d: dISO, patrimonio: patrimonio, fluxo: fluxoDia, prov: provDia,
              fluxoRV: fluxoRVdia, fluxoRF: aporteRFdia,
              rv: valRV, rf: valRF, fu: valFU, fluxoFU: fluxoFUdia, cobertura: cobertura, fx: (fx > 0 ? fx : null),
              usd: valUSD   // 27/10/2026: parte da renda variável em dólar (US$), para separar ativos × câmbio
            });
          }
          cursor = addDays(cursor, 1);
        }

        if (serie.length < 2) return null;
        /* 26/10/2026: proventos chegaram DURANTE o cálculo (a busca de proventos
           roda junto com a série na abertura). Antes, a série pronta era jogada
           fora logo em seguida ("os lançamentos mudaram... reconstruindo"),
           ninguém refazia, e o aviso de carregamento só saía no teto de 25 s.
           Agora refaz uma vez, na hora, com os proventos novos (os preços já
           estão na memória, leva menos de 1 s). */
        try {
          var _sigFim = _sigCarteira(opts.aportes || [], opts.rendaFixa || [], fuLista);
          if (!opts._refeito && _sigFim && _sigIni && _sigFim !== _sigIni) {
            var _provNovos = [];
            try { _provNovos = JSON.parse(localStorage.getItem('g20_rvDividendos') || '[]') || []; } catch(e2){}
            console.log('[G20Rent] proventos chegaram durante o cálculo — refazendo a série com eles (sem descartar).');
            var _o2 = {}; Object.keys(opts).forEach(function(k){ _o2[k] = opts[k]; });
            _o2.proventos = _provNovos; _o2._refeito = true;
            return API.calcular(_o2);
          }
        } catch(e){}
        /* 27/10/2026: guarda o que o cálculo usou, para o resultado por ativo
           ("quem mais somou") sem nova rodada de rede. */
        API._ultimo = { precos: precos, cambio: cambio, eventos: eventos, mapaAtivos: mapaAtivos,
                        prov: _provLista, sig: _sigIni, em: Date.now() };
        /* Modo só-consulta: calcula sem trocar a série em uso nem gravar nada. */
        if (opts._semGravar) return serie;
        // MEMÓRIA primeiro: o localStorage pode estourar a cota com ~3000 pontos e falhar
        // silenciosamente. Sem isso, cache() devolvia null e TODOS os painéis caíam no
        // cálculo antigo (via snapshots), exibindo percentuais errados.
        API._serieMem = serie;
        API._ehVelha = false; API._velha = null;   // a série do dia substitui a anterior
        API._serieUid = API._uidDono || null;   // carimbo de dono (isolamento)
        API._serieSig = _sigIni;                // assinatura dos lançamentos usados
        // A série é o maior consumidor de cota — vai pro IndexedDB (centenas
        // de MB) em vez do localStorage (~5MB). A memória cobre o uso síncrono
        // desta sessão; o IndexedDB persiste para as próximas sem estourar.
        try {
          /* out/2026: "incompleta" agora é só falha PASSAGEIRA. Antes, qualquer
             ativo sem cotação marcava a série assim, inclusive os que nunca vão
             ter cotação (saíram da bolsa). Com BPYU, CIO e BRKB na carteira ela
             era incompleta para sempre: não subia para a nuvem e a cópia do
             aparelho vencia em 30 min, então o dashboard refazia tudo (13 s) a
             cada abertura. Ativo que segue sem cotação há mais de 6 h, ou que
             está na lista dos que saíram da bolsa, conta como permanente. */
          var _incompleta = false;
          try {
            var _SH_K = 'g20_rent_semhist', _sh = {}, _agoraSH = Date.now(), _shNovo = {};
            try { _sh = JSON.parse(localStorage.getItem(_SH_K) || '{}') || {}; } catch(e){ _sh = {}; }
            Object.keys(pos).forEach(function (tk) {
              if (!(pos[tk] > 0.000001)) return;
              var temPx = precos[tk] && precos[tk].em(hoje) != null;
              if (temPx) return;
              var base = String(tk).replace(/\.SA$/i, '').toUpperCase();
              _shNovo[tk] = _sh[tk] || _agoraSH;
              if (DELISTADOS[base]) return;
              if ((_agoraSH - _shNovo[tk]) > 6 * 3600 * 1000) return;   // permanente
              _incompleta = true;
            });
            localStorage.setItem(_SH_K, JSON.stringify(_shNovo));
            window._g20SemCotacaoSerie = Object.keys(_shNovo);
          } catch(e){}
          var _payload = { at: Date.now(), uid: (API._uidDono || null), sig: API._serieSig, serie: serie, mv: MOTOR_NUVEM,
                           /* falha passageira de cotação: guarda só por 30 min e tenta de novo */
                           incompleta: _incompleta };
          if (window.G20Store) G20Store.set(SERIE_KEY, _payload);
          else localStorage.setItem(SERIE_KEY, JSON.stringify(_payload));
          if (!_payload.incompleta) API._paraNuvem(_payload);
        } catch (e) { console.warn('[G20Rent] série: falha ao persistir — usando memória'); }
        return serie;
      });
    },

    retornoPeriodo: function (serie, periodo) {
      if (!serie || serie.length < 2) return null;
      var hoje = parseISO(serie[serie.length - 1].d);
      var ini;
      if (periodo === 'ytd') ini = new Date(hoje.getFullYear(), 0, 1);
      else if (periodo === '1m') { ini = new Date(hoje); ini.setMonth(ini.getMonth() - 1); }
      else if (periodo === '6m') { ini = new Date(hoje); ini.setMonth(ini.getMonth() - 6); }
      else if (periodo === '1a') { ini = new Date(hoje); ini.setFullYear(ini.getFullYear() - 1); }
      else if (periodo === '5a') { ini = new Date(hoje); ini.setFullYear(ini.getFullYear() - 5); }
      else ini = parseISO(serie[0].d);
      var iniISO = iso(ini);
      var corte = serie.filter(function (p) { return p.d >= iniISO; });
      if (corte.length < 2) return null;
      /* 28/10/2026: UMA CONTA SÓ. O período usa a mesma curva da série (API.curva, com as mesmas regras de
         cobertura, saldo mínimo e teto diário) que a Minha Carteira, a Carteira G20 e o robô usam. Antes,
         esta conta tinha regras próprias e o Dashboard podia mostrar um número diferente das outras telas. */
      var c = API.curva(serie, corte[0].d);
      return c ? (c[c.length - 1].f - 1) * 100 : twr(corte);
    },

    /* Retorno total + composição por classe no fim do período. */
    porClasse: function (serie, periodo) {
      if (!serie || serie.length < 2) return null;
      var ult = serie[serie.length - 1];
      var tot = ult.patrimonio || 1;
      return {
        total: API.retornoPeriodo(serie, periodo),
        valorRV: ult.rv || 0,
        valorRF: ult.rf || 0,
        pesoRV: (ult.rv || 0) / tot * 100,
        pesoRF: (ult.rf || 0) / tot * 100,
        cobertura: ult.cobertura
      };
    },

    cache: function () {
      // Memória tem prioridade — não depende de cota nem de serialização.
      if (API._serieMem && API._serieMem.length >= 2) {
        var _sigAgora = _sigCarteira();
        if (_sigAgora && API._serieSig !== _sigAgora) {
          console.log('[G20Rent] os lançamentos mudaram desde que a série foi montada — reconstruindo.');
          API._serieMem = null; API._serieSig = null;
          try { window._g20HistPronto = false; } catch(e){}
          try { localStorage.removeItem(SERIE_KEY); } catch(e){}
          try { if (window.G20Store) G20Store.del(SERIE_KEY); } catch(e){}
          /* 26/10/2026: descartou, então refaz (uma vez por abertura). Antes
             ficava sem série até a próxima abertura da página. */
          try { if (typeof window._g20RefazerSerie === 'function') setTimeout(window._g20RefazerSerie, 800); } catch(e){}
          return null;
        }
        return API._serieMem;
      }
      try {
        var c = JSON.parse(localStorage.getItem(SERIE_KEY) || 'null');
        /* 24/10/2026: guardada com outra versão do cálculo (mv) vale só como "anterior" */
        if (c && c.at && (!_serieFresca(c.at) || c.mv !== MOTOR_NUVEM) && c.serie && c.serie.length >= 2) API._guardarVelha(c);
        if (c && c.at && _serieFresca(c.at) && c.mv === MOTOR_NUVEM && c.serie && c.serie.length >= 2) {
          /* ═══════════════════════════════════════════════════════════════
             ISOLAMENTO POR USUÁRIO (sessão 51.0)
             A série carrega o patrimônio inteiro de quem a montou. Se o dono
             carimbado não for o usuário logado, ela NÃO pode ser usada — foi
             exatamente assim que o dashboard de um aluno novo apareceu com o
             patrimônio do admin. Série sem carimbo é de versão anterior a
             esta correção: descarta por precaução.
             ═══════════════════════════════════════════════════════════════ */
          if (!API._uidDono || !c.uid || c.uid !== API._uidDono) {
            console.warn('[G20Rent] série de OUTRO usuário (ou sem dono) — descartada.');
            try { localStorage.removeItem(SERIE_KEY); } catch(e){}
            try { if (window.G20Store) G20Store.del(SERIE_KEY); } catch(e){}
            return null;
          }
          /* A série vale enquanto os APORTES não mudarem. Se algum preço foi
             corrigido DEPOIS que ela foi montada, ela carrega os números
             velhos — descarta e reconstrói. */
          var _mudou = false;
          try {
            var _ap = JSON.parse(localStorage.getItem('g20_rvAportes')||'[]');
            for (var _i = 0; _i < _ap.length; _i++) {
              var _t = _ap[_i] && _ap[_i]._precoCorrigidoEm;
              if (_t && new Date(_t).getTime() > c.at) { _mudou = true; break; }
            }
          } catch(e){}
          if (_mudou) {
            console.log('[G20Rent] aportes corrigidos depois desta série — reconstruindo.');
            try { localStorage.removeItem(SERIE_KEY); } catch(e){}
            return null;
          }
          var _sigLS = _sigCarteira();
          if (c.incompleta && (Date.now() - c.at) > 30 * 60 * 1000) {
            API._guardarVelha(c);
            try { localStorage.removeItem(SERIE_KEY); } catch(e){}
            return null;
          }
          if (_sigLS && c.sig !== _sigLS) {
            console.log('[G20Rent] série guardada é de outra versão dos lançamentos — reconstruindo.');
            try { localStorage.removeItem(SERIE_KEY); } catch(e){}
            return null;
          }
          API._serieMem = c.serie;
          API._serieUid = c.uid;
          API._serieSig = c.sig;
          return c.serie;
        }
      } catch (e) {}
      return null;
    },
    /* Sobe a série completa para users/{uid}/dados/rentSerie (só o dono lê). */
    _paraNuvem: function (payload) {
      /* 26/10/2026: no Modo Live a série é da carteira de demonstração e não
         vai para a nuvem. Antes o Modo Live barrava a gravação, mas este log
         dizia "série guardada na nuvem" mesmo assim. */
      if (window.G20Live && window.G20Live.ativo) { console.log('[G20Rent] Modo Live: série de demonstração, não enviada para a nuvem.'); return; }
      try {
        var ref = _refNuvem(payload && payload.uid);
        if (!ref || !payload.sig || !payload.serie || payload.serie.length < 2) return;
        var _t0 = Date.now();
        _comprimir(JSON.stringify(payload.serie)).then(function (c) {
          if (!c || !c.d || c.d.length > 950000) { console.warn('[G20Rent] série grande demais para a nuvem — fica só no aparelho.'); return; }
          return ref.set({ motor: MOTOR_NUVEM, uid: payload.uid, at: payload.at, sig: payload.sig,
                           n: payload.serie.length, gz: c.gz, d: c.d }).then(function () {
            console.log('[G20Rent] série guardada na nuvem: ' + payload.serie.length + ' dias, ' +
                        Math.round(c.d.length / 1024) + ' KB (' + (Date.now() - _t0) + 'ms)');
          });
        }).catch(function (e) { console.warn('[G20Rent] não guardou a série na nuvem:', e && e.message); });
      } catch (e) {}
    },

    /* Usa a série da nuvem se valerem as mesmas regras da cópia local.
       Devolve uma Promise<boolean>. */
    daNuvem: function (doc) {
      return new Promise(function (resolve) {
        try {
          if (!doc || API._serieMem || !API._uidDono) return resolve(false);
          if (doc.uid !== API._uidDono || doc.motor !== MOTOR_NUVEM || !doc.d) return resolve(false);
          var sigAgora = _sigCarteira();
          if (!doc.at || !_serieFresca(doc.at)) {
            /* out/2026: antiga, mas dos MESMOS lançamentos: serve para abrir a
               tela na hora enquanto a de hoje é calculada por trás. */
            if (sigAgora && doc.sig === sigAgora && !(API._velha && API._velha.at >= doc.at)) {
              return _descomprimir(doc).then(function (serieV) {
                if (Array.isArray(serieV) && serieV.length >= 2) API._guardarVelha({ uid: doc.uid, sig: doc.sig, at: doc.at, serie: serieV });
                console.log('[G20Rent] série da nuvem é de antes do último pregão — abre com ela e atualiza por trás.');
                resolve(false);
              }, function () { resolve(false); });
            }
            console.log('[G20Rent] série da nuvem é de antes do último pregão — recalculando.');
            return resolve(false);
          }
          if (!sigAgora || doc.sig !== sigAgora) { console.log('[G20Rent] lançamentos mudaram desde a série da nuvem — recalculando.'); return resolve(false); }
          try {
            var _ap = JSON.parse(localStorage.getItem('g20_rvAportes') || '[]');
            for (var i = 0; i < _ap.length; i++) {
              var t = _ap[i] && _ap[i]._precoCorrigidoEm;
              if (t && new Date(t).getTime() > doc.at) return resolve(false);
            }
          } catch (e) {}
          var _t0 = Date.now();
          _descomprimir(doc).then(function (serie) {
            if (!serie || !Array.isArray(serie) || serie.length < 2) return resolve(false);
            if (API._serieMem || doc.uid !== API._uidDono) return resolve(false);
            API._serieMem = serie;
            API._serieUid = doc.uid;
            API._serieSig = doc.sig;
            try {
              if (window.G20Store) G20Store.set(SERIE_KEY, { at: doc.at, uid: doc.uid, sig: doc.sig, serie: serie, incompleta: false, mv: MOTOR_NUVEM });
            } catch (e) {}
            console.log('[G20Rent] ✓ série pronta da nuvem: ' + serie.length + ' dias, sem recalcular (' + (Date.now() - _t0) + 'ms)');
            resolve(true);
          }, function () { resolve(false); });
        } catch (e) { resolve(false); }
      });
    },

    /* ── SÉRIE ANTERIOR (out/2026, abertura rápida) ─────────────────────
       Guardada quando a série salva é de antes do último pregão. Não vale
       como série do dia, mas é do mesmo dono e dos mesmos lançamentos:
       abre a tela com ela na hora, e a do dia é calculada por trás e troca
       os números quando termina. Antes a tela ficava 13 s no aviso de
       carregamento esperando um dia a mais de dados. */
    _velha: null,
    _ehVelha: false,
    _guardarVelha: function (c) {
      try {
        if (!c || !c.serie || c.serie.length < 2 || !c.at) return;
        if (API._velha && API._velha.at >= c.at) return;
        API._velha = { uid: c.uid || null, sig: c.sig || null, at: c.at, serie: c.serie };
      } catch (e) {}
    },
    usarVelha: function () {
      var v = API._velha;
      if (!v || API._serieMem || !API._uidDono || v.uid !== API._uidDono) return false;
      var sig = _sigCarteira();
      if (!sig || v.sig !== sig) return false;
      API._serieMem = v.serie; API._serieSig = v.sig; API._serieUid = v.uid;
      API._ehVelha = true;
      return v;
    },

    _serieMem: null,
    _serieSig: null,       // assinatura dos lançamentos que geraram _serieMem
    _serieUid: null,       // uid do dono da série que está em _serieMem
    _uidDono: null,        // uid confirmado pelo Firebase Auth
    _serieQuarentena: null,// série lida do IndexedDB ANTES do auth resolver

    /* ═══════════════════════════════════════════════════════════════════
       definirDono(uid) — chamada pelo onAuthStateChanged

       POR QUE ISTO EXISTE
       O pré-carregamento da série do IndexedDB dispara no boot do script,
       muito antes do Firebase Auth dizer quem está logado. Sem esta trava,
       a série de quem usou o navegador antes já estava em memória quando o
       aluno novo chegava — e todos os painéis (patrimônio, desempenho,
       benchmarks, rentabilidade, proventos, KPIs) mostravam os números da
       outra pessoa. Os cards que liam g20_rvAportes apareciam zerados, o
       que mascarava o problema e fazia parecer que o isolamento funcionava.

       Agora a série pré-carregada fica em QUARENTENA e só é promovida a
       memória depois que o auth confirma que o dono bate.
       ═══════════════════════════════════════════════════════════════════ */
    definirDono: function (uid) {
      API._uidDono = uid || null;

      /* ═══════════════════════════════════════════════════════════════════
         CARTEIRA VAZIA NÃO TEM SÉRIE — R51

         O carimbo de dono resolve o vazamento entre CONTAS diferentes. Falta
         uma trava para o caso do mesmo navegador: se a carteira pessoal está
         vazia, não existe série possível, e qualquer série em memória é
         resíduo — de um cálculo anterior, de outra fonte, do que for.

         O sintoma apareceu na conta de teste: aluno sem nenhum aporte, com
         "Minha Carteira: aguardando dados…", e ao mesmo tempo Rentabilidade
         +36,37% e Alpha +28,52 pp, com um degrau no gráfico em 26/Mar.
         Números de uma carteira que não é dele, num painel que deveria
         estar zerado.

         Zero aportes, zero renda fixa, zero bens = sem série. Ponto.
         ═══════════════════════════════════════════════════════════════════ */
      var _vazia = false;
      try {
        var _rv = JSON.parse(localStorage.getItem('g20_rvAportes')   || '[]');
        var _rf = JSON.parse(localStorage.getItem('g20_rendaFixa')   || '[]');
        var _bn = JSON.parse(localStorage.getItem('g20_patrimonioBens') || '[]');
        _vazia = ((_rv.length || 0) + (_rf.length || 0) + (_bn.length || 0)) === 0;
      } catch(e){}

      if (_vazia) {
        if (API._serieMem || API._serieQuarentena) {
          console.warn('[G20Rent] carteira pessoal vazia — série descartada ' +
                       '(era resíduo, não pertence a esta carteira).');
        }
        API._serieMem = null;
        API._serieUid = null;
        API._serieQuarentena = null;
        try { window._g20HistPronto = false; } catch(e){}
        try { localStorage.removeItem(SERIE_KEY); } catch(e){}
        try { if (window.G20Store) G20Store.del(SERIE_KEY); } catch(e){}
        return API._uidDono;
      }

      if (API._velha && API._velha.uid !== API._uidDono) API._velha = null;
      // 1) Série já em memória de outro dono? Fora.
      if (API._serieMem && API._serieUid !== API._uidDono) {
        console.warn('[G20Rent] série em memória era de outro usuário — descartada.');
        API._serieMem = null;
        API._serieUid = null;
        try { window._g20HistPronto = false; } catch (e) {}
        try { localStorage.removeItem(SERIE_KEY); } catch (e) {}
        try { if (window.G20Store) G20Store.del(SERIE_KEY); } catch (e) {}
      }

      // 2) Promove (ou descarta) o que veio do IndexedDB antes do auth.
      var q = API._serieQuarentena;
      API._serieQuarentena = null;
      if (q) {
        /* 24/10/2026: série de outra versão do cálculo não vale como atual */
        if (q.uid && q.uid === API._uidDono && q.mv !== MOTOR_NUVEM) {
          try { API._guardarVelha(q); } catch(e){}
        } else
        if (q.uid && q.uid === API._uidDono && q.serie && q.serie.length >= 2) {
          API._serieMem = q.serie;
          API._serieUid = q.uid;
          API._serieSig = q.sig || null;
          try { window._g20HistPronto = true; } catch (e) {}
          console.log('[G20Rent] série do próprio usuário liberada da quarentena.');
        } else {
          console.warn('[G20Rent] série em quarentena não pertence a este usuário — descartada.');
          try { if (window.G20Store) G20Store.del(SERIE_KEY); } catch (e) {}
        }
      }
      return API._uidDono;
    },

    /* Invalida a série reconstruída. Necessário quando os APORTES mudam
       (correção de preço por desdobramento, novo aporte, edição): a série
       foi montada com os dados antigos e continuaria mostrando os números
       velhos até o TTL expirar. */
    invalidar: function () {
      API._serieMem = null;
      API._velha = null; API._ehVelha = false;
      API._serieUid = null;
      API._serieQuarentena = null;
      try { localStorage.removeItem(SERIE_KEY); } catch (e) {}
      try { if (window.G20Store) G20Store.del(SERIE_KEY); } catch (e) {}
      try { window._g20HistPronto = false; } catch (e) {}
      console.log('[G20Rent] cache da série invalidado — será reconstruída.');
    },

    limparCache: function () {
      try {
        localStorage.removeItem(SERIE_KEY);
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k);
        });
      } catch (e) {}
    },

    _twr: twr, _stooqSymbol: stooqSymbol, _yahooSymbol: yahooSymbol, _coinId: coinId,
    _rfBruto: rfBruto, _rfLiquido: rfLiquido, _construirEventos: construirEventos
  };

  /* ═══════════════════════════════════════════════════════════════════════
     27/10/2026 · FUNÇÕES PARA OS GRÁFICOS (aba Gráficos da Minha Carteira)
     Nada aqui muda a série nem os números do Dashboard: só lê a série pronta.
     ═══════════════════════════════════════════════════════════════════════ */
  function _faixa(serie, ini, fim) {
    /* índices do ponto de PARTIDA (último dia <= ini) e de CHEGADA (último <= fim) */
    var a = -1, b = -1;
    for (var i = 0; i < serie.length; i++) {
      if (serie[i].d <= ini) a = i;
      if (serie[i].d <= fim) b = i;
    }
    if (a < 0) a = 0;
    return (b > a) ? [a, b] : null;
  }

  /* Rentabilidade (TWR) com a MESMA regra dos cards do Dashboard (_v21TwrDesde):
     o aporte do dia sai da conta, provento recebido é retorno, dias com cobertura
     de preços diferente da do dia anterior (ou abaixo de 80%) não contam o
     movimento, saldo anterior abaixo de R$ 500 não conta e variação diária acima
     de 40% é descartada (desdobramento não ajustado, preço furado).
     curva() devolve o acumulado ponto a ponto (para o gráfico); twrDesde() o total
     do período em % (para o placar e o calendário). Mesma carteira, mesmo número. */
  var TWR_SALDO_MIN = 500, TWR_TETO_DIA = 0.40, TWR_COB_MIN = 0.80;
  API.curva = function (serie, ini) {
    serie = serie || API.cache();
    if (!serie || serie.length < 2) return null;
    var out = [], fator = 1, ok = false;
    for (var i = 0; i < serie.length; i++) {
      if (serie[i].d < ini) continue;
      if (!ok) { ok = true;
        /* 28/10/2026: no primeiro dia da carteira, a compra feita acima ou abaixo do fechamento já é ganho ou
           perda (como em qualquer aporte depois). Antes, o primeiro dia começava do fechamento e só ele
           ficava de fora. */
        var p00 = serie[i], fl0 = p00.fluxo || 0, c00 = p00.cobertura === undefined ? 1 : p00.cobertura;
        if (i === 0 && fl0 > TWR_SALDO_MIN && p00.patrimonio > 0 && c00 >= TWR_COB_MIN && Math.abs(p00.patrimonio / fl0 - 1) <= TWR_TETO_DIA) fator = p00.patrimonio / fl0;
        out.push({ i: i, d: serie[i].d, f: fator }); continue; }
      var p0 = serie[i - 1], p1 = serie[i];
      var vIni = p0.patrimonio, pr = p1.prov || 0, fl = p1.fluxo || 0;
      var provR = (pr > 0 && vIni > TWR_SALDO_MIN) ? pr / vIni : 0;
      var soProv = function () { if (provR && isFinite(provR)) fator *= (1 + provR); };
      var cA = (p0.cobertura === undefined) ? 1 : p0.cobertura, cB = (p1.cobertura === undefined) ? 1 : p1.cobertura;
      if (Math.abs(cB - cA) > 0.001 || cB < TWR_COB_MIN) soProv();
      else if (vIni > TWR_SALDO_MIN) {
        var r = (p1.patrimonio - fl - vIni) / vIni;
        if (!isFinite(r) || Math.abs(r) > TWR_TETO_DIA) soProv();
        else fator *= (1 + r + provR);
      }
      out.push({ i: i, d: p1.d, f: fator });
    }
    return out.length >= 2 ? out : null;
  };
  API.twrDesde = function (serie, ini) {
    var c = API.curva(serie, ini);
    return c ? (c[c.length - 1].f - 1) * 100 : null;
  };

  /* De onde veio o resultado: separa o ganho do período em ativos (preço),
     câmbio (variação do dólar sobre a parte em dólar), proventos e renda fixa.
     Por dia: câmbio = parte em US$ de ontem × (dólar de hoje − dólar de ontem);
     ativos = variação da renda variável − aportes nela − câmbio.
     A soma das quatro partes é o ganho do período (variação − aportes + proventos). */
  API.decompor = function (serie, ini, fim) {
    serie = serie || API.cache();
    if (!serie || serie.length < 2) return null;
    var f = _faixa(serie, ini, fim); if (!f) return null;
    var o = { ativos: 0, cambio: 0, proventos: 0, rendaFixa: 0, fundos: 0, aportes: 0, temDolar: true,
              inicio: serie[f[0]].d, fim: serie[f[1]].d };
    for (var i = f[0] + 1; i <= f[1]; i++) {
      var p0 = serie[i - 1], p1 = serie[i];
      var dRV = (p1.rv || 0) - (p0.rv || 0) - (p1.fluxoRV || 0);
      var cb = 0;
      if (p0.usd == null) o.temDolar = false;
      else if (p0.fx > 0 && p1.fx > 0) cb = p0.usd * (p1.fx - p0.fx);
      o.cambio += cb;
      o.ativos += dRV - cb;
      o.rendaFixa += (p1.rf || 0) - (p0.rf || 0) - (p1.fluxoRF || 0);
      o.fundos += (p1.fu || 0) - (p0.fu || 0) - (p1.fluxoFU || 0);   // 28/10/2026: Fundos e Previdência
      o.proventos += (p1.prov || 0);
      o.aportes += (p1.fluxo || 0);
    }
    o.total = o.ativos + o.cambio + o.proventos + o.rendaFixa + o.fundos;
    return o;
  };

  /* TIR (taxa interna de retorno) do período, ao ano: considera QUANDO e
     QUANTO entrou de dinheiro. Fluxos: o patrimônio do início como saída,
     cada aporte como saída, cada provento recebido como entrada e o patrimônio
     do fim como entrada. Resolve por bissecção. */
  API.tir = function (serie, ini, fim) {
    serie = serie || API.cache();
    if (!serie || serie.length < 2) return null;
    var f = _faixa(serie, ini, fim); if (!f) return null;
    var t0 = Date.parse(serie[f[0]].d + 'T12:00:00Z'), fl = [];
    var anos = function (d) { return (Date.parse(d + 'T12:00:00Z') - t0) / (365.25 * 86400000); };
    if (serie[f[0]].patrimonio > 0) fl.push([0, -serie[f[0]].patrimonio]);
    for (var i = f[0] + 1; i <= f[1]; i++) {
      var p = serie[i], liq = (p.prov || 0) - (p.fluxo || 0);
      if (liq) fl.push([anos(p.d), liq]);
    }
    fl.push([anos(serie[f[1]].d), serie[f[1]].patrimonio]);
    var T = anos(serie[f[1]].d);
    if (!(T > 0)) return null;
    var vp = function (r) { var s = 0; for (var k = 0; k < fl.length; k++) s += fl[k][1] / Math.pow(1 + r, fl[k][0]); return s; };
    var lo = -0.99, hi = 10;
    if (vp(lo) * vp(hi) > 0) return null;
    for (var it = 0; it < 200; it++) { var md = (lo + hi) / 2; if (vp(md) > 0) lo = md; else hi = md; }
    return (lo + hi) / 2;
  };

  /* Resultado por ativo no período (em R$): valor no fim − valor no início
     − aportes no ativo + proventos do ativo. Usa os preços do último cálculo;
     se não houver (série veio pronta da nuvem), faz um cálculo só-consulta com
     os preços guardados no aparelho, sem trocar nada do que está na tela. */
  function _porAtivoCalc(U, ini, fim) {
    var fxEm = function (d) { var v = U.cambio ? U.cambio.em(d) : null; return v > 0 ? v : null; };
    var usd = function (tk) { return !!(U.mapaAtivos[tk] && U.mapaAtivos[tk].moeda === 'USD'); };
    var qI = {}, qF = {}, apo = {}, prov = {};
    U.eventos.forEach(function (e) {
      if (e.d <= ini) qI[e.ticker] = (qI[e.ticker] || 0) + e.qtd;
      if (e.d <= fim) qF[e.ticker] = (qF[e.ticker] || 0) + e.qtd;
      if (e.d > ini && e.d <= fim) {
        var P = U.precos[e.ticker]; if (!P) return;
        var c = e.custo;
        if (e.mov || e.semPreco) { var px = _primeiroPreco(P, e.d); if (!(px > 0)) return; c = e.qtd * px; }
        if (e.moeda === 'USD') { var f = fxEm(e.d); if (!f) return; c = c * f; }
        apo[e.ticker] = (apo[e.ticker] || 0) + c;
      }
    });
    var vistos = {};
    (U.prov || []).forEach(function (d) {
      if (!d || d.isExDate || !d.ticker || !d.fonte) return;
      var tk = String(d.ticker).toUpperCase().replace(/\.SA$/, '');
      var dt = String(d.data || '').substring(0, 10);
      if (!(dt > ini && dt <= fim) || !U.mapaAtivos[tk] || U.mapaAtivos[tk].cripto) return;
      var total = parseFloat(d.total);
      if (!(total > 0)) total = (parseFloat(d.valorCota) || 0) * (parseFloat(d.qtd) || 0);
      if (!(total > 0)) return;
      var chave = tk + '|' + dt + '|' + (Math.round((parseFloat(d.valorCota) || total) * 1e6));
      if (vistos[chave]) return; vistos[chave] = 1;
      var moeda = d.moeda || (usd(tk) ? 'USD' : 'BRL');
      if (moeda === 'USD') { var f = fxEm(dt); if (!f) return; total = total * f; }
      prov[tk] = (prov[tk] || 0) + total;
    });
    function valor(tk, q, d) {
      if (!(q > 1e-9)) return 0;
      var P = U.precos[tk]; if (!P) return null;
      var px = P.em(d); if (!(px > 0)) return null;
      var v = q * px;
      if (usd(tk)) { var f = fxEm(d); if (!f) return null; v = v * f; }
      return v;
    }
    var out = [];
    Object.keys(U.mapaAtivos).forEach(function (tk) {
      var vi = valor(tk, qI[tk] || 0, ini), vf = valor(tk, qF[tk] || 0, fim);
      if (vi == null || vf == null) return;
      if (!vi && !vf && !apo[tk]) return;
      var r = vf - vi - (apo[tk] || 0) + (prov[tk] || 0);
      out.push({ ticker: tk, resultado: r, valorInicio: vi, valorFim: vf, aportes: apo[tk] || 0, proventos: prov[tk] || 0 });
    });
    out.sort(function (x, y) { return y.resultado - x.resultado; });
    return out;
  }
  API.porAtivo = function (ini, fim, opts) {
    var sig = _sigCarteira();
    if (API._ultimo && (!sig || API._ultimo.sig === sig)) return Promise.resolve(_porAtivoCalc(API._ultimo, ini, fim));
    if (!opts || !opts.aportes) return Promise.resolve(null);
    var o = {}; Object.keys(opts).forEach(function (k) { o[k] = opts[k]; }); o._semGravar = true;
    return API.calcular(o).then(function () { return API._ultimo ? _porAtivoCalc(API._ultimo, ini, fim) : null; });
  };

  /* Referências diárias: CDI, IPCA, Ibovespa, IFIX (arquivos diários do G20
     em dados/bcb) e S&P 500 (proxy). O Ibovespa é completado pelo proxy nos dias
     que o arquivo ainda não tem; o CDI repete a última taxa nos dias úteis que
     faltam. Cada uma vem como nível acumulado: ret(k, ini, fim) dá a variação. */
  var _refsP = null;
  API.referencias = function () {
    if (_refsP) return _refsP;
    var j = function (u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); };
    var diaUtil = function (d) { var w = parseISO(d).getDay(); return w !== 0 && w !== 6; };
    var hojeI = iso(new Date());
    function nivelDiario(pares, taxaPct) {
      var pts = [], nv = 1, ult = null, last = null;
      (pares || []).forEach(function (p) { var v = parseFloat(p[1]); if (!isFinite(v)) return;
        if (taxaPct) { nv = nv * (1 + v / 100); last = v; } else nv = v;
        pts.push({ d: p[0], c: nv }); ult = p[0]; });
      if (taxaPct && ult && last != null) {
        for (var d = addDays(parseISO(ult), 1); iso(d) <= hojeI; d = addDays(d, 1)) {
          var s = iso(d); if (!diaUtil(s)) continue; nv = nv * (1 + last / 100); pts.push({ d: s, c: nv });
        }
      }
      return pts;
    }
    function ipcaDiario(pares) {
      var pts = [], nv = 1;
      (pares || []).forEach(function (p) { var v = parseFloat(p[1]); if (!isFinite(v)) return;
        var d0 = parseISO(p[0]), d1 = addDays(new Date(d0.getFullYear(), d0.getMonth() + 1, 1), 0), n = Math.round((d1 - d0) / 86400000) || 30;
        var fd = Math.pow(1 + v / 100, 1 / n);
        for (var k = 0; k < n; k++) { pts.push({ d: iso(addDays(d0, k)), c: nv }); nv = nv * fd; } });
      return pts;
    }
    _refsP = Promise.all([j('dados/bcb/sgs-12.json'), j('dados/bcb/sgs-433.json'), j('dados/bcb/b3-indice-IBOV.json'), j('dados/bcb/b3-indice-IFIX.json')]).then(function (r) {
      var cdi = nivelDiario(r[0] && r[0].dados, true), ipca = ipcaDiario(r[1] && r[1].dados);
      var ibov = (r[2] && r[2].dados || []).map(function (p) { return { d: p[0], c: parseFloat(p[1]) }; });
      var ifix = (r[3] && r[3].dados || []).map(function (p) { return { d: p[0], c: parseFloat(p[1]) }; });
      var ibUlt = ibov.length ? ibov[ibov.length - 1].d : '2019-01-01';
      var _sc = API.cache(), desde5 = (_sc && _sc[0] && _sc[0].d) || iso(addDays(new Date(), -365 * 5));   // desde o início da série
      return Promise.all([
        buscarYahoo('^BVSP', ibUlt).catch(function () { return null; }),
        buscarYahoo('^GSPC', desde5).catch(function () { return null; }),
        (API._ultimo && API._ultimo.cambio) ? Promise.resolve(API._ultimo.cambio) :
          buscarYahoo('USDBRL=X', desde5).then(function (p) { return p ? indexar(p) : null; }).catch(function () { return null; })
      ]).then(function (y) {
        if (y[0] && y[0].length) y[0].forEach(function (p) { if (p.d > ibUlt) ibov.push({ d: p.d, c: p.c }); });
        var spU = y[1] || [], cb = y[2];
        var spB = cb ? spU.map(function (p) { var f = cb.em(p.d); return f > 0 ? { d: p.d, c: p.c * f } : null; }).filter(Boolean) : [];
        var R = { cdi: indexar(cdi), ipca: indexar(ipca), ibov: indexar(ibov), ifix: indexar(ifix), sp500: indexar(spU), sp500brl: indexar(spB),
                  ate: { cdi: r[0] && r[0].ate, ibov: ibov.length ? ibov[ibov.length - 1].d : null, ifix: r[3] && r[3].ate } };
        R.ret = function (k, ini, fim) { var s = R[k]; if (!s) return null; var a = s.em(ini), b = s.em(fim); return (a > 0 && b > 0) ? b / a - 1 : null; };
        return R;
      });
    });
    _refsP.catch(function () { _refsP = null; });
    return _refsP;
  };

  global.G20Rent = API;

  /* Pré-carrega a série do IndexedDB, mas NÃO a coloca em uso ainda.

     ATENÇÃO: este trecho roda no boot do script, antes do Firebase Auth
     dizer quem está logado. Se a série for promovida aqui, ela vaza para
     a próxima conta que abrir o dashboard neste navegador — foi assim que
     o aluno de teste viu o patrimônio do admin.

     A série fica em QUARENTENA. Quem libera é G20Rent.definirDono(uid),
     chamada pelo onAuthStateChanged, e só se o carimbo de dono bater. */
  try {
    if (window.G20Store) {
      G20Store.get(SERIE_KEY).then(function (c) {
        /* out/2026: série de antes do último pregão (ou incompleta há mais de
           30 min) não é apagada: fica como "anterior" para abrir a tela na hora. */
        var _velhaIdb = c && c.at && c.serie && c.serie.length >= 2 &&
                        (!_serieFresca(c.at) || c.mv !== MOTOR_NUVEM || (c.incompleta && (Date.now() - c.at) > 30 * 60 * 1000));
        if (_velhaIdb) {
          if (!API._uidDono || c.uid === API._uidDono) API._guardarVelha(c);
          return;
        }
        if (c && c.at && _serieFresca(c.at) && c.serie && c.serie.length >= 2) {
          if (API._uidDono) {
            // Auth já resolveu antes do IndexedDB responder: decide na hora.
            if (c.uid && c.uid === API._uidDono) {
              if (!API._serieMem) {
                API._serieMem = c.serie;
                API._serieSig = c.sig || null;
                API._serieUid = c.uid;
                try { window._g20HistPronto = true; } catch(e){}
              }
            } else {
              console.warn('[G20Rent] série do IndexedDB é de outro usuário — descartada.');
              try { G20Store.del(SERIE_KEY); } catch(e){}
            }
          } else {
            // Auth ainda não resolveu: guarda sem usar.
            API._serieQuarentena = { uid: (c.uid || null), serie: c.serie, at: c.at, sig: c.sig || null };
          }
        }
      }).catch(function(){});
    }
  } catch (e) {}
})(typeof window !== 'undefined' ? window : this);
