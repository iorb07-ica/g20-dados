#!/usr/bin/env python3
"""
Curva oficial do Tesouro americano para a Renda Fixa no exterior do G20 Hub (28/10/2026).

Baixa a "Daily Treasury Par Yield Curve Rates" do Departamento do Tesouro dos EUA
(home.treasury.gov, gratuita, sem chave) e grava em dados/ust/:
  hoje.json        { base, ant, t:[prazos em anos], c:[taxas % no último dia], ca:[dia anterior] }
  hist/AAAA.json   { t:[prazos], d:[datas], c:[[taxas por data]] }   (desde 2015)
Reserva: se o site do Tesouro falhar, usa a mesma série publicada pelo FRED (Fed de St. Louis).
A plataforma usa a curva para marcar Treasury e bonds a mercado (taxa do prazo que falta
+ o spread da compra). Roda pela tarefa .github/workflows/ust-curva.yml.
Só biblioteca padrão do Python.
"""
import csv, io, json, os, sys, urllib.request, datetime

T = [1/12, 2/12, 3/12, 4/12, 6/12, 1, 2, 3, 5, 7, 10, 20, 30]
T_R = [round(x, 4) for x in T]
DESDE = 2015
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dados', 'ust')
URL = ('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
       '{y}/all?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv')
FRED = ['DGS1MO', None, 'DGS3MO', None, 'DGS6MO', 'DGS1', 'DGS2', 'DGS3', 'DGS5', 'DGS7', 'DGS10', 'DGS20', 'DGS30']


def baixar(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (G20 Hub dados publicos)'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode('utf-8-sig', 'replace')


def prazo(nome):
    """'1 Mo' -> 1/12, '1.5 Month' -> None (fora da grade), '10 Yr' -> 10"""
    n = nome.strip().lower().replace('month', 'mo').replace('year', 'yr')
    try:
        v, u = n.split()[0], n.split()[1]
        v = float(v)
    except (ValueError, IndexError):
        return None
    anos = v / 12 if u.startswith('mo') else v if u.startswith('yr') else None
    if anos is None:
        return None
    for i, t in enumerate(T):
        if abs(t - anos) < 1e-6:
            return i
    return None


def ano_tesouro(y):
    texto = baixar(URL.format(y=y))
    leitor = csv.reader(io.StringIO(texto))
    cab = next(leitor)
    col = {j: prazo(c) for j, c in enumerate(cab) if j > 0}
    linhas = {}
    for lin in leitor:
        if not lin or '/' not in lin[0]:
            continue
        m, d, a = lin[0].strip().split('/')
        iso = f'{a}-{int(m):02d}-{int(d):02d}'
        v = [None] * len(T)
        for j, i in col.items():
            if i is None or j >= len(lin):
                continue
            try:
                v[i] = round(float(lin[j]), 3)
            except ValueError:
                pass
        if any(x is not None for x in v):
            linhas[iso] = v
    return linhas


def ano_fred(y):
    ids = [f for f in FRED if f]
    texto = baixar('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + ','.join(ids)
                   + f'&cosd={y}-01-01&coed={y}-12-31')
    leitor = csv.reader(io.StringIO(texto))
    cab = next(leitor)
    linhas = {}
    for lin in leitor:
        if not lin or not lin[0].startswith(str(y)):
            continue
        v = [None] * len(T)
        for j, nome in enumerate(cab[1:], 1):
            if nome in FRED:
                try:
                    v[FRED.index(nome)] = round(float(lin[j]), 3)
                except ValueError:
                    pass
        if any(x is not None for x in v):
            linhas[lin[0]] = v
    return linhas


def ano(y):
    for f in (ano_tesouro, ano_fred):
        try:
            l = f(y)
            if l:
                print(f'{y}: {len(l)} dias ({f.__name__})')
                return l
        except Exception as e:  # noqa: BLE001
            print(f'{y}: {f.__name__} falhou: {e}')
    return {}


def main():
    hist = os.path.join(SAIDA, 'hist')
    os.makedirs(hist, exist_ok=True)
    hoje = datetime.date.today()
    anos = []
    for y in range(DESDE, hoje.year + 1):
        arq = os.path.join(hist, f'{y}.json')
        # anos fechados só são baixados uma vez; o ano corrente (e o anterior em janeiro) sempre
        if not os.path.exists(arq) or y == hoje.year or (hoje.month == 1 and y == hoje.year - 1):
            anos.append(y)
    ultimo = {}
    for y in anos:
        l = ano(y)
        if not l:
            continue
        ds = sorted(l)
        with open(os.path.join(hist, f'{y}.json'), 'w', encoding='utf-8') as f:
            json.dump({'t': T_R, 'd': ds, 'c': [l[d] for d in ds]}, f, separators=(',', ':'))
        if y >= hoje.year - 1:
            ultimo.update(l)
    if not ultimo:
        arq = os.path.join(hist, f'{hoje.year}.json')
        if os.path.exists(arq):
            j = json.load(open(arq, encoding='utf-8'))
            ultimo = dict(zip(j['d'], j['c']))
    if not ultimo:
        sys.exit('curva do Tesouro americano indisponível')
    ds = sorted(ultimo)
    base, ant = ds[-1], ds[-2] if len(ds) > 1 else ds[-1]
    with open(os.path.join(SAIDA, 'hoje.json'), 'w', encoding='utf-8') as f:
        json.dump({'base': base, 'ant': ant, 'fonte': 'U.S. Department of the Treasury (Daily Par Yield Curve)',
                   't': T_R, 'c': ultimo[base], 'ca': ultimo[ant]}, f, separators=(',', ':'))
    print(f'curva de {base} (anterior {ant}): 10 anos = {ultimo[base][10]}%')


if __name__ == '__main__':
    main()
