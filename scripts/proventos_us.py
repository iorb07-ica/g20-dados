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
  diagnostico = não grava nada; mostra no log uma amostra. Com o ano inicial antes do ano
                passado, a amostra é de janeiro daquele ano (para testar se há dados antigos);
                senão, da última semana
Bolsas: só entram ativos que são ou foram listados na NYSE, Nasdaq, NYSE American, NYSE Arca
ou Cboe (lista da própria Polygon, ativos e já saídos da bolsa, refeita uma vez por semana em
dados/proventos/us-bolsas.json). Balcão (OTC) fica de fora, e arquivos de quem não é
listado são apagados.
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
BOLSAS = os.path.join(RAIZ, 'dados', 'proventos', 'us-bolsas.json')
# Bolsas onde os alunos conseguem comprar (Avenue, Inter etc.): NYSE, Nasdaq, NYSE American,
# NYSE Arca (ETFs) e Cboe. Quem só existe no balcão (OTC) fica fora da base.
LISTA_BOLSAS = ['XNYS', 'XNAS', 'XASE', 'ARCX', 'BATS']
LISTADOS = None
CHAVE = os.environ.get('POLYGON_API_KEY', '').strip()
MODO = (os.environ.get('MODO') or 'atualizar').strip()
ANO_INICIO = int(os.environ.get('ANO_INICIO') or '2016')
LIMITE_MIN = float(os.environ.get('MINUTOS') or '320')
ESPERA = 12.5
T0 = time.time()
TICKER_OK = re.compile(r'^[A-Z][A-Z0-9.\-]{0,9}$')
# Fundos mútuos americanos (5 letras terminando em X, ex.: VFIAX, AABCX): não são negociados
# em bolsa nem comprados pelas corretoras dos alunos. Ficam de fora (metade dos registros).
FUNDO_MUTUO = re.compile(r'^[A-Z]{4}X$')
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
    if not TICKER_OK.match(t) or FUNDO_MUTUO.match(t) or (LISTADOS is not None and t not in LISTADOS) or not ex or not isinstance(v, (int, float)) or v <= 0:
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


def carregar_bolsas(hoje):
    """Lista de quem é ou foi listado nas bolsas. Refaz se tiver mais de 7 dias."""
    global LISTADOS
    est = {}
    if os.path.exists(BOLSAS):
        try: est = json.load(open(BOLSAS, encoding='utf-8'))
        except Exception: est = {}
    idade = 999
    try: idade = (hoje - datetime.date.fromisoformat(est.get('atualizado', '2000-01-01'))).days
    except Exception: pass
    if idade >= 7 or len(est.get('tickers') or []) < 5000:
        print('Atualizando a lista de ativos listados nas bolsas...')
        novos, ok = set(), True
        for b in LISTA_BOLSAS:
            for ativo in ('true', 'false'):
                url = ('https://api.polygon.io/v3/reference/tickers?market=stocks&exchange=%s&active=%s&limit=1000&sort=ticker&order=asc' % (b, ativo))
                n0, pag = len(novos), 0
                try:
                    while url and pag < 200:
                        d = consultar(com_chave(url)); pag += 1
                        for x in d.get('results') or []:
                            if x.get('ticker'): novos.add(str(x['ticker']).upper())
                        url = d.get('next_url')
                except Exception as e:
                    print(f'  {b} ({"ativos" if ativo == "true" else "saídos"}): erro {e}'); ok = False
                print(f'  {b} ({"ativos" if ativo == "true" else "saídos"}): +{len(novos) - n0} em {pag} página(s)')
        if ok and len(novos) >= 5000:
            est = {'atualizado': hoje.isoformat(), 'bolsas': LISTA_BOLSAS, 'tickers': sorted(novos)}
            json.dump(est, open(BOLSAS, 'w', encoding='utf-8'), separators=(',', ':'))
        else:
            print('  Lista incompleta: mantida a anterior' if est.get('tickers') else '  Lista incompleta: sem filtro de bolsa nesta rodada')
    if len(est.get('tickers') or []) >= 5000:
        LISTADOS = set(est['tickers'])
        print(f'Ativos listados nas bolsas: {len(LISTADOS)}')


def podar(hoje):
    """Apaga arquivos de ativos que não são nem foram listados nas bolsas."""
    if LISTADOS is None or not os.path.isdir(PASTA): return
    n = 0
    for f in os.listdir(PASTA):
        if f.endswith('.json') and (f[:-5] not in LISTADOS or FUNDO_MUTUO.match(f[:-5])):
            os.remove(os.path.join(PASTA, f)); n += 1
    print(f'Fora das bolsas (balcão) apagados: {n}')


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
    carregar_bolsas(hoje)
    if MODO == 'diagnostico':
        if ANO_INICIO < hoje.year - 1:
            janela(f'{ANO_INICIO}-01-01', f'{ANO_INICIO}-01-31', h)
        else:
            janela((hoje - datetime.timedelta(days=7)).isoformat(), h, h)
        return 0
    if MODO == 'atualizar':
        janela((hoje - datetime.timedelta(days=60)).isoformat(), (hoje + datetime.timedelta(days=400)).isoformat(), h)
        podar(hoje)
        gravar_indice(h)
        return 0
    # completo: mês a mês, retomando de onde parou
    est = {}
    if os.path.exists(ESTADO):
        try: est = json.load(open(ESTADO, encoding='utf-8'))
        except Exception: est = {}
    # Meses já baixados. Antes guardava só "até onde foi"; agora guarda cada mês, para dar
    # para voltar no tempo (ex.: carga de 2016 feita, depois completar de 2000 a 2015).
    feitos = set(est.get('meses') or [])
    if not feitos and est.get('completoAte'):
        ini0 = est.get('desde') or '2016-01'          # a primeira carga (out/2026) começou em 2016
        a0, m0 = int(ini0[:4]), int(ini0[5:7])
        while f'{a0}-{m0:02d}' <= est['completoAte']:
            feitos.add(f'{a0}-{m0:02d}'); a0, m0 = (a0 + (m0 == 12), 1 if m0 == 12 else m0 + 1)
    a, m = ANO_INICIO, 1
    fim_total = hoje + datetime.timedelta(days=400)
    while datetime.date(a, m, 1) <= fim_total:
        chave = f'{a}-{m:02d}'
        prox = (a + (m == 12), 1 if m == 12 else m + 1)
        # os meses a partir do mês passado sempre são baixados de novo (podem mudar)
        if chave not in feitos or chave >= (hoje.replace(day=1) - datetime.timedelta(days=1)).strftime('%Y-%m'):
            ini = datetime.date(a, m, 1).isoformat()
            fim = (datetime.date(prox[0], prox[1], 1) - datetime.timedelta(days=1)).isoformat()
            try:
                janela(ini, fim, h)
            except TimeoutError:
                print('Limite de tempo: o que foi feito está gravado; rode de novo para continuar.'); break
            feitos.add(chave)
            est['meses'] = sorted(feitos); est['completoAte'] = max(feitos); est['em'] = h
            json.dump(est, open(ESTADO, 'w', encoding='utf-8'))
        a, m = prox
        if (time.time() - T0) / 60 > LIMITE_MIN:
            print('Limite de tempo: rode de novo para continuar.'); break
    else:
        ini_ant = est.get('desde') or f'{ANO_INICIO}-01-01'
        est['cargaCompleta'] = True; est['desde'] = min(ini_ant, f'{ANO_INICIO}-01-01')
        json.dump(est, open(ESTADO, 'w', encoding='utf-8'))
        print('Carga completa concluída.')
    podar(hoje)
    gravar_indice(h)
    return 0


if __name__ == '__main__':
    sys.exit(main())
