#!/usr/bin/env python3
"""
Base de empresas (out/2026) para a busca inteligente do G20 Hub.

Para que serve: a busca reconhece ativos pelo nome ("ford", "taesa", "realty income")
mesmo quando o aluno não tem o ativo na carteira. Antes ela só conhecia ~300 nomes
populares escritos à mão. Este robô monta, uma vez por semana, um arquivo com os nomes
de todas as empresas, FIIs, Fiagros e ETFs que já estão nas bases do g20-dados:

  dados/empresas.json
    {"atualizado": "AAAA-MM-DD",
     "br": [["TAEE11", "TAESA", "acao"], ...],      ticker, nome curto, tipo
     "us": [["F", "FORD MOTOR"], ...]}               ticker, nome curto

Fontes (todas gratuitas, sem chave):
  Brasil  dados/proventos/br/*.json (a base da B3 deste repositório: nome e tipo de cada
          ativo que paga proventos). Ativo que nunca pagou provento não entra.
  EUA     lista oficial da SEC (www.sec.gov/files/company_tickers_exchange.json), cruzada
          com dados/proventos/us-bolsas.json (só o que é listado em NYSE, Nasdaq, NYSE
          American, NYSE Arca e Cboe; balcão fica fora). A SEC pede um User-Agent com
          contato. Se a SEC falhar, a parte dos EUA fica como estava no arquivo anterior.

Nome curto: sem sufixos como S.A., INC, CORP, HOLDINGS, ON, PN, FII, FUNDO DE
INVESTIMENTO..., para o arquivo ficar leve (é baixado pelo aparelho do aluno só quando a
busca precisa reconhecer um nome que não conhece).
Roda pela tarefa .github/workflows/empresas.yml.
"""
import datetime, functools, glob, json, os, re, sys, urllib.request

print = functools.partial(print, flush=True)
RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SAIDA = os.path.join(RAIZ, 'dados', 'empresas.json')
BR = os.path.join(RAIZ, 'dados', 'proventos', 'br')
BOLSAS = os.path.join(RAIZ, 'dados', 'proventos', 'us-bolsas.json')
SEC_URL = 'https://www.sec.gov/files/company_tickers_exchange.json'
UA = 'G20 Hub (Valorize G20 Masterclass) contato@g20hub.com'

RUIDO = re.compile(r'\b(S\.?\s?A\.?|S/A|LTDA|CIA|COMPANHIA|INC\.?|INCORPORATED|CORP\.?|CORPORATION|CO\.?|COMPANY|LTD\.?|PLC|N\.?V\.?|AG|SE|LP|L\.P\.|LLC|HOLDINGS?|GROUP|THE|'
                   r'ON|PN|PNA|PNB|UNT|UNITS?|NM|N1|N2|EJ|ED|EDJ|DRN?|ADR|ADS|FDO|FUNDO|FII|FIAGRO|FI-INFRA|FIDC|DE|DO|DA|DOS|DAS|E|INVESTIMENTO|INVESTIMENTOS|IMOBILIARIO|IMOBILIÁRIO|'
                   r'RESPONSABILIDADE|LIMITADA|CLASSE|COTAS?|CL|CLASS|COMMON|STOCK|SHARES?|ORD|ORDINARY|NEW)\b', re.I)

def curto(nome):
    n = re.sub(r'[,()"\']', ' ', str(nome or '')).upper()
    n = RUIDO.sub(' ', n)
    n = re.sub(r'\s+-\s+.*$', '', n)          # tira "- DC", "- RESPONSABILIDADE..."
    n = re.sub(r'[^A-Z0-9À-Ú&. ]', ' ', n)
    n = re.sub(r'\s+', ' ', n).strip(' .')
    return ' '.join(n.split(' ')[:4])

def ler_br():
    out = []
    for f in sorted(glob.glob(os.path.join(BR, '*.json'))):
        try:
            j = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        t = str(j.get('ticker') or os.path.basename(f)[:-5]).upper()
        nome = curto(j.get('nome') or '')
        if not re.match(r'^[A-Z]{4}\d{1,2}$', t) or not nome:
            continue
        tipo = str(j.get('tipoAtivo') or '').lower() or ('fii' if t.endswith('11') else 'acao')
        out.append([t, nome, tipo])
    return out

def ler_us(anterior):
    try:
        listados = set(json.load(open(BOLSAS, encoding='utf-8')).get('tickers') or [])
    except Exception:
        listados = set()
    try:
        req = urllib.request.Request(SEC_URL, headers={'User-Agent': UA, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.load(r)
    except Exception as e:
        print('SEC falhou (%s): mantenho a parte dos EUA do arquivo anterior.' % e)
        return anterior, False
    campos = j.get('fields') or []
    try:
        i_t, i_n, i_e = campos.index('ticker'), campos.index('name'), campos.index('exchange')
    except ValueError:
        print('SEC mudou o formato: mantenho a parte dos EUA do arquivo anterior.')
        return anterior, False
    out, vistos = [], set()
    for d in j.get('data') or []:
        t = str(d[i_t] or '').upper().replace('-', '.')
        ex = str(d[i_e] or '')
        if not t or t in vistos or ex.upper() == 'OTC':
            continue
        if listados and t not in listados and t.replace('.', '-') not in listados:
            continue
        nome = curto(d[i_n])
        if nome:
            out.append([t, nome]); vistos.add(t)
    return out, True

def main():
    anterior = {}
    try:
        anterior = json.load(open(SAIDA, encoding='utf-8'))
    except Exception:
        pass
    br = ler_br()
    us, ok_sec = ler_us(anterior.get('us') or [])
    hoje = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).strftime('%Y-%m-%d')
    novo = {'atualizado': hoje, 'br': br, 'us': us}
    # só regrava se o conteúdo mudou (a data sozinha não conta)
    if anterior.get('br') == br and anterior.get('us') == us:
        print('Nada mudou: %d na B3, %d nos EUA.' % (len(br), len(us)))
        return
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, 'w', encoding='utf-8') as f:
        json.dump(novo, f, ensure_ascii=False, separators=(',', ':'))
    print('Gravado: %d na B3, %d nos EUA (SEC %s), %d KB.' % (len(br), len(us), 'ok' if ok_sec else 'falhou', os.path.getsize(SAIDA) // 1024))

if __name__ == '__main__':
    sys.exit(main())
