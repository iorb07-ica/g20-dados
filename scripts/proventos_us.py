#!/usr/bin/env python3
"""
Base de proventos dos EUA (out/2026) para a Plataforma G20 / G20 Hub.

Por que existe: a Minha Carteira buscava os proventos americanos ativo por ativo, no
navegador do aluno, na Polygon gratuita (5 consultas por minuto). Com muitos ativos a
busca levava mais de 10 minutos e, se o aluno saía da tela, os ativos do fim da fila
nunca eram buscados. Agora este robô baixa uma vez por dia os proventos de TODO o
mercado americano (ações, REITs e ETFs), consultando por data e não por ativo, e grava
um arquivo por ativo, no mesmo molde da base da B3:

  dados/proventos/us/{TICKER}.json
    {"ticker": "DELL", "atualizado": "AAAA-MM-DD",
     "proventos": [{"ex": "AAAA-MM-DD", "pag": "AAAA-MM-DD", "rec": ..., "dec": ...,
                    "valor": 0.63, "tipo": "CD", "freq": 4}]}
  tipo: CD = dividendo comum, SC = especial, LT/ST = ganho de capital (fundos)

Fonte: Polygon (api.polygon.io, hoje Massive), plano gratuito, chave no segredo
POLYGON_API_KEY do repositório. Espera 12,5 s entre consultas (limite de 5 por minuto).

Modos (variável MODO):
  atualizar   = rotina diária: data ex de 60 dias atrás até 400 dias à frente (poucos minutos)
  completo    = carga desde ANO_INICIO, mês a mês. Para no limite de tempo e grava o que
                fez; rodar de novo continua de onde parou (dados/proventos/us-estado.json)
  diagnostico = não grava nada; mostra no log uma página de exemplo
Também grava dados/proventos/us-indice.json: {"atualizado", "completo", "tickers": [...]}.
Com "completo": true, ativo fora da lista é ativo que não pagou proventos no período
(a Minha Carteira não precisa consultar a Polygon por ele).
Roda pela tarefa .github/workflows/proventos-us.yml.
"""
import datetime, functools, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

print = functools.partial(print, flush=True)
RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PASTA = os.path.join(RAIZ, 'dados', 'proventos', 'us')
ESTADO = os.path.join(RAIZ, 'dados', 'proventos', 'us-estado.json')
INDICE = os.path.join(RAIZ, 'dados', 'proventos', 'us-indice.json')
CHAVE = os.environ.get('POLYGON_API_KEY', '').strip()
MODO = (os.environ.get('MODO') or 'atualizar').strip()
ANO_INICIO = int(os.environ.get('ANO_INICIO') or '2016')
LIMITE_MIN = float(os.environ.get('MINUTOS') or '320')
ESPERA = 12.5
T0 = time.time()
TICKER_OK = re.compile(r'^[A-Z][A-Z0-9.\-]{0,9}$')
_ultima = [0.0]


def hoje_sp():
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).date()


def consultar(url):
    """GET na Polygon respeitando 5 consultas por minuto; tenta de novo em erro passageiro."""
    for tentativa in range(6):
        falta = ESPERA - (time.time() - _ultima[0])
        if falta > 0:
            time.sleep(falta)
        _ultima[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'G20 Hub (dados abertos)', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print('    limite da Polygon: esperando 65 s'); time.sleep(65); continue
            if e.code in (500, 502, 503, 504):
                time.sleep(20 * (tentativa + 1)); continue
            raise
        except Exception:
            time.sleep(20 * (tentativa + 1))
    raise RuntimeError('Polygon não respondeu depois de várias tentativas')


def com_chave(url):
    return url + ('&' if '?' in url else '?') + 'apiKey=' + urllib.parse.quote(CHAVE)


def baixar_janela(ini, fim, limite_paginas=400):
    """Todos os proventos com data ex entre ini e fim (inclusive), de todo o mercado."""
    url = ('https://api.polygon.io/v3/reference/dividends?ex_dividend_date.gte=%s&ex_dividend_date.lte=%s'
           '&limit=1000&sort=ex_dividend_date&order=asc' % (ini, fim))
    tudo, paginas = [], 0
    while url and paginas < limite_paginas:
        d = consultar(com_chave(url))
        tudo.extend(d.get('results') or [])
        paginas += 1
        url = d.get('next_url')
        if (time.time() - T0) / 60 > LIMITE_MIN:
            raise TimeoutError('limite de tempo no meio da janela')
    return tudo, paginas


def normalizar(x):
    t = str(x.get('ticker') or '').upper()
    ex = str(x.get('ex_dividend_date') or '')[:10]
    v = x.get('cash_amount')
    if not TICKER_OK.match(t) or not ex or not isinstance(v, (int, float)) or v <= 0:
        return None, None
    moeda = (x.get('currency') or 'USD').upper()
    if moeda != 'USD':
        return None, None
    p = {'ex': ex, 'pag': str(x.get('pay_date') or '')[:10] or None, 'rec': str(x.get('record_date') or '')[:10] or None,
         'dec': str(x.get('declaration_date') or '')[:10] or None, 'valor': round(float(v), 8),
         'tipo': x.get('dividend_type') or 'CD', 'freq': x.get('frequency')}
    return t, p


def gravar(por_ticker, janela_ini, janela_fim, hoje):
    """Junta os proventos baixados com o que cada arquivo já tinha. Dentro da janela
    baixada, vale o que a Polygon mandou agora (correções e cancelamentos entram)."""
    n_arq = 0
    os.makedirs(PASTA, exist_ok=True)
    for t, novos in por_ticker.items():
        caminho = os.path.join(PASTA, t + '.json')
        antigos = []
        if os.path.exists(caminho):
            try: antigos = json.load(open(caminho, encoding='utf-8')).get('proventos', [])
            except Exception: antigos = []
        fora = [p for p in antigos if not (janela_ini <= p.get('ex', '') <= janela_fim)]
        visto, lista = set(), []
        for p in fora + novos:
            k = (p['ex'], p.get('pag'), p['tipo'], p['valor'])
            if k in visto: continue
            visto.add(k); lista.append(p)
        lista.sort(key=lambda p: (p['ex'], p.get('pag') or ''), reverse=True)
        json.dump({'ticker': t, 'atualizado': hoje, 'fonte': 'Polygon', 'proventos': lista},
                  open(caminho, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        n_arq += 1
    return n_arq


def janela(ini, fim, hoje):
    brutos, paginas = baixar_janela(ini, fim)
    por = {}
    for x in brutos:
        t, p = normalizar(x)
        if t: por.setdefault(t, []).append(p)
    if MODO == 'diagnostico':
        print(f'  {ini} a {fim}: {len(brutos)} registros em {paginas} página(s), {len(por)} ativos')
        for t in sorted(por)[:8]: print('   ', t, json.dumps(por[t][:2]))
        return 0
    n = gravar(por, ini, fim, hoje)
    print(f'  {ini} a {fim}: {len(brutos)} proventos de {len(por)} ativos ({paginas} página(s)); {n} arquivos gravados')
    return n


def gravar_indice(hoje):
    est = {}
    if os.path.exists(ESTADO):
        try: est = json.load(open(ESTADO, encoding='utf-8'))
        except Exception: est = {}
    tickers = sorted(f[:-5] for f in os.listdir(PASTA) if f.endswith('.json')) if os.path.isdir(PASTA) else []
    json.dump({'atualizado': hoje, 'completo': bool(est.get('cargaCompleta')), 'desde': est.get('desde'), 'tickers': tickers},
              open(INDICE, 'w', encoding='utf-8'), separators=(',', ':'))
    print(f'Índice: {len(tickers)} ativos; carga completa: {"sim" if est.get("cargaCompleta") else "ainda não"}')


def main():
    if not CHAVE:
        print('Falta o segredo POLYGON_API_KEY no repositório (Settings > Secrets and variables > Actions).'); return 1
    hoje = hoje_sp()
    h = hoje.isoformat()
    print(f'Modo {MODO}; hoje {h}')
    if MODO == 'diagnostico':
        janela((hoje - datetime.timedelta(days=7)).isoformat(), h, h); return 0
    if MODO == 'atualizar':
        janela((hoje - datetime.timedelta(days=60)).isoformat(), (hoje + datetime.timedelta(days=400)).isoformat(), h)
        gravar_indice(h)
        return 0
    # completo: mês a mês, retomando de onde parou
    est = {}
    if os.path.exists(ESTADO):
        try: est = json.load(open(ESTADO, encoding='utf-8'))
        except Exception: est = {}
    feito = est.get('completoAte') or ''
    a, m = ANO_INICIO, 1
    fim_total = hoje + datetime.timedelta(days=400)
    while datetime.date(a, m, 1) <= fim_total:
        chave = f'{a}-{m:02d}'
        prox = (a + (m == 12), 1 if m == 12 else m + 1)
        if chave > feito:
            ini = datetime.date(a, m, 1).isoformat()
            fim = (datetime.date(prox[0], prox[1], 1) - datetime.timedelta(days=1)).isoformat()
            try:
                janela(ini, fim, h)
            except TimeoutError:
                print('Limite de tempo: o que foi feito está gravado; rode de novo para continuar.'); break
            est['completoAte'] = chave; est['em'] = h
            json.dump(est, open(ESTADO, 'w', encoding='utf-8'))
        a, m = prox
        if (time.time() - T0) / 60 > LIMITE_MIN:
            print('Limite de tempo: rode de novo para continuar.'); break
    else:
        est['cargaCompleta'] = True; est['desde'] = f'{ANO_INICIO}-01-01'
        json.dump(est, open(ESTADO, 'w', encoding='utf-8'))
        print('Carga completa concluída.')
    gravar_indice(h)
    return 0


if __name__ == '__main__':
    sys.exit(main())
