#!/usr/bin/env python3
"""
Preços oficiais do Tesouro Direto para a Plataforma G20 (out/2026).

Baixa o arquivo público do Tesouro Transparente (PrecoTaxaTesouroDireto.csv,
gratuito, atualizado todo dia) e grava, na pasta dados/tesouro/:
  hoje.json            preço de mercado (PU Base) de cada título no último dia
                       disponível e no dia anterior, mais a taxa
  hist/<sub>_<venc>.json  preço de compra de cada dia, desde 2012, só dos
                       títulos que ainda não venceram (para a plataforma
                       estimar quantos títulos o aluno comprou)
Roda pela tarefa automática .github/workflows/tesouro-precos.yml.
Só biblioteca padrão do Python: nada para instalar.
"""
import csv, io, json, os, sys, urllib.request, datetime

URL = ('https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/'
       'resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv')
SUB = {
    'Tesouro Selic': 'selic', 'Tesouro Prefixado': 'prefixado',
    'Tesouro Prefixado com Juros Semestrais': 'prefixado_juros',
    'Tesouro IPCA+': 'ipca', 'Tesouro IPCA+ com Juros Semestrais': 'ipca_juros',
    'Tesouro Renda+ Aposentadoria Extra': 'rendamais', 'Tesouro Educa+': 'educa',
}
DESDE = '2012-01-01'
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dados', 'tesouro')


def num(v):
    v = (v or '').strip().replace('.', '').replace(',', '.')
    try:
        return float(v)
    except ValueError:
        return 0.0


def iso(br):
    d, m, a = br.strip().split('/')
    return f'{a}-{m}-{d}'


def baixar():
    req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0 (Plataforma G20)'})
    with urllib.request.urlopen(req, timeout=180) as r:
        bruto = r.read()
    for enc in ('utf-8-sig', 'latin-1'):
        try:
            return bruto.decode(enc)
        except UnicodeDecodeError:
            pass
    return bruto.decode('latin-1', 'replace')


def montar(texto):
    leitor = csv.reader(io.StringIO(texto), delimiter=';')
    cab = [c.strip() for c in next(leitor)]
    ix = {n: cab.index(n) for n in ('Tipo Titulo', 'Data Vencimento', 'Data Base',
                                    'Taxa Venda Manha', 'PU Compra Manha', 'PU Base Manha')}
    titulos = {}   # chave -> { data: (pu_compra, pu_base, taxa) }
    for lin in leitor:
        if len(lin) < len(cab):
            continue
        sub = SUB.get(lin[ix['Tipo Titulo']].strip())
        if not sub:
            continue
        try:
            venc, base = iso(lin[ix['Data Vencimento']]), iso(lin[ix['Data Base']])
        except ValueError:
            continue
        titulos.setdefault(f'{sub}|{venc}', {})[base] = (
            num(lin[ix['PU Compra Manha']]), num(lin[ix['PU Base Manha']]), num(lin[ix['Taxa Venda Manha']]))
    return titulos


def main():
    titulos = montar(baixar())
    if not titulos:
        sys.exit('arquivo do Tesouro veio vazio')
    datas = sorted({d for t in titulos.values() for d in t})
    base = datas[-1]
    ant = datas[-2] if len(datas) > 1 else base
    hoje = {'base': base, 'ant': ant, 'fonte': 'Tesouro Transparente (PU Base)', 't': {}}
    for k, dias in titulos.items():
        if base in dias and dias[base][1] > 0:
            pb, pa = dias[base][1], (dias.get(ant) or dias[base])[1]
            hoje['t'][k] = [round(pb, 2), round(pa or pb, 2), round(dias[base][2], 2)]
    os.makedirs(os.path.join(SAIDA, 'hist'), exist_ok=True)
    with open(os.path.join(SAIDA, 'hoje.json'), 'w', encoding='utf-8') as f:
        json.dump(hoje, f, ensure_ascii=False, separators=(',', ':'))
    hoje_iso = datetime.date.today().isoformat()
    n = 0
    for k, dias in titulos.items():
        sub, venc = k.split('|')
        if venc <= hoje_iso:
            continue
        ds = sorted(d for d in dias if d >= DESDE)
        if not ds:
            continue
        p = [round(dias[d][0] if dias[d][0] > 0 else dias[d][1], 2) for d in ds]
        with open(os.path.join(SAIDA, 'hist', f'{sub}_{venc}.json'), 'w', encoding='utf-8') as f:
            json.dump({'d': ds, 'p': p}, f, separators=(',', ':'))
        n += 1
    print(f'preço de {base} (anterior {ant}): {len(hoje["t"])} títulos; histórico de {n} títulos')


if __name__ == '__main__':
    main()
