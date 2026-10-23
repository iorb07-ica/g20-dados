#!/usr/bin/env python3
"""
Bonificações da B3 com o custo atribuído (out/2026) para a Plataforma G20.

Por que existe: a Minha Carteira detecta bonificações (aviso 🎁), mas o custo de cada ação
bonificada só aparece no fato relevante da empresa. Este robô monta a base de 2016 para cá
para que a plataforma lance a bonificação sozinha, com o custo oficial.

Fonte (gratuita, sem chave): dados abertos da CVM, documentos eventuais (IPE) de todas as
companhias abertas, um arquivo por ano:
  https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_AAAA.zip
De cada ano pega os Fatos Relevantes, Avisos aos Acionistas e Comunicados que falam de
bonificação (ou de aumento de capital), baixa o documento no sistema da CVM e lê:
  percentual (3%, ou "1 ação nova para cada 25"), data-com (posição acionária de DD/MM/AAAA)
  e custo atribuído ("custo atribuído às ações bonificadas será de R$ 22,70 por ação").
Quando a empresa diz que não atribui custo, grava custo 0 com semCusto: true.

Grava em dados/proventos/:
  bonificacoes.json         {atualizado, eventos:[{codigoCVM, empresa, tickers, dataDoc, categoria,
                             link, dataCom, percentual, custo, semCusto, status, trecho}]}
                            status: ok (custo lido), sem-custo, revisar (bonificação sem custo lido)
  bonificacoes-estado.json  protocolos já lidos (a rodada seguinte não baixa de novo)
Os códigos de negociação de cada empresa vêm de dados/proventos/br/*.json (campo codigoCVM).

Modos (variável MODO): atualizar (ano atual e anterior), completo (desde ANO_INICIO),
diagnostico (não grava; mostra no log o que acharia, limitado a 15 documentos).
Roda pela tarefa .github/workflows/bonificacoes.yml. Precisa de pypdf (pip).
"""
import csv, datetime, functools, glob, io, json, os, re, sys, time, unicodedata, urllib.request, zipfile

print = functools.partial(print, flush=True)
RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SAIDA = os.path.join(RAIZ, 'dados', 'proventos', 'bonificacoes.json')
ESTADO = os.path.join(RAIZ, 'dados', 'proventos', 'bonificacoes-estado.json')
URL_IPE = 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_{a}.zip'
MODO = os.environ.get('MODO', 'atualizar').strip() or 'atualizar'
ANO_INICIO = int(os.environ.get('ANO_INICIO', '2016'))
LIMITE_MIN = float(os.environ.get('MINUTOS', '300'))
CATEGORIAS = ('fato relevante', 'aviso aos acionistas', 'comunicado ao mercado')
UA = {'User-Agent': 'Mozilla/5.0 (G20 Hub; dados abertos)'}
T0 = time.time()

def sem_acento(s):
    return unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()

def baixar(url, tentativas=3, espera=4):
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except Exception as e:
            if i == tentativas - 1: raise
            time.sleep(espera * (i + 1))

def num_br(s):
    s = s.strip().rstrip('.,')
    return float(s.replace('.', '').replace(',', '.'))

def data_br(s):
    m = re.search(r'(\d{1,2})[/.](\d{1,2})[/.](\d{4})', s)
    if not m: return ''
    try: return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    except ValueError: return ''

# ── leitura do documento ──────────────────────────────────────────────────
def texto_pdf(dados):
    from pypdf import PdfReader
    if dados[:2] == b'PK':                     # às vezes a CVM entrega um ZIP com o PDF dentro
        z = zipfile.ZipFile(io.BytesIO(dados))
        nomes = [n for n in z.namelist() if n.lower().endswith('.pdf')]
        if not nomes: return ''
        dados = z.read(nomes[0])
    if dados[:4] != b'%PDF':
        try: return dados.decode('utf-8', 'ignore')   # alguns vêm em HTML/texto
        except Exception: return ''
    r = PdfReader(io.BytesIO(dados))
    return '\n'.join((p.extract_text() or '') for p in r.pages[:12])

R_NUM = r'(\d{1,3}(?:\.\d{3})*,\d{2,12}|\d+,\d{2,12})'
R_CUSTO = [
    r'custo(?:\s+unitario)?(?:\s+de\s+aquisicao)?\s+atribuido[^.;]{0,220}?r\s?\$\s?' + R_NUM,
    r'custo(?:\s+unitario)?(?:\s+de\s+aquisicao)?\s+(?:das|de\s+cada|por)\s+(?:novas?\s+)?ac(?:oes|ao)\s+bonificadas?[^.;]{0,220}?r\s?\$\s?' + R_NUM,
    r'ac(?:oes|ao)\s+bonificadas?[^.;]{0,120}?custo[^.;]{0,120}?r\s?\$\s?' + R_NUM,
    r'valor\s+(?:de\s+)?r\s?\$\s?' + R_NUM + r'\s+por\s+acao[^.;]{0,80}?(?:custo|bonificad)',
]
R_SEM_CUSTO = r'(nao\s+sera\s+atribuido\s+(?:valor\s+de\s+)?custo|sem\s+atribuicao\s+de\s+custo|nao\s+(?:havera|haver)\s+atribuicao\s+de\s+custo|custo\s+(?:de\s+aquisicao\s+)?(?:sera\s+)?(?:igual\s+a\s+)?(?:zero|r\s?\$\s?0,00))'
R_PCT = [
    r'(?:a\s+razao|na\s+proporcao|equivalente)\s+de\s+(\d{1,3}(?:,\d+)?)\s?%',
    r'bonificacao\s+(?:em\s+acoes\s+)?de\s+(\d{1,3}(?:,\d+)?)\s?%',
    r'(\d{1,3}(?:,\d+)?)\s?%\s*\([^)]{0,40}\)\s*(?:de\s+)?(?:bonificacao|em\s+acoes|das\s+acoes)',
]
# "1 (uma) nova ação para cada 25", "uma ação nova para cada 25", "10 (dez) ações novas para cada 100 (cem)"
R_PROP = r'(\d+|uma|duas|tres)\s*(?:\([a-z ]{2,30}\)\s*)?(?:(?:nova|novas)\s+ac(?:oes|ao)|ac(?:oes|ao)\s+(?:nova|novas))[^.;]{0,80}?para\s+cada\s+(\d+)'
R_PROP2 = R_PROP
_PALAVRAS = {'uma': 1, 'duas': 2, 'tres': 3}
R_DATACOM = [
    r'posic(?:ao|oes)\s+acionarias?[^;]{0,160}?(\d{1,2}/\d{1,2}/\d{4})',
    r'data[\s-]+(?:base|com)[^.;]{0,100}?(\d{1,2}/\d{1,2}/\d{4})',
    r'acionistas\s+(?:titulares|detentores)[^.;]{0,160}?(\d{1,2}/\d{1,2}/\d{4})',
]

def analisar(txt):
    t = re.sub(r'\s+', ' ', sem_acento(txt))
    if 'bonific' not in t: return None
    out = {'percentual': None, 'dataCom': '', 'custo': None, 'semCusto': False, 'trecho': ''}
    for rx in R_CUSTO:
        m = re.search(rx, t)
        if m:
            try:
                out['custo'] = round(num_br(m.group(1)), 10)
                ini = max(0, m.start() - 40); out['trecho'] = t[ini:m.end() + 20][:300]
                break
            except ValueError: pass
    if out['custo'] is None:
        m = re.search(R_SEM_CUSTO, t)
        if m: out['custo'] = 0.0; out['semCusto'] = True; out['trecho'] = t[max(0, m.start() - 60):m.end() + 40][:300]
    for rx in R_PCT:
        m = re.search(rx, t)
        if m:
            try:
                v = num_br(m.group(1) + (',0' if ',' not in m.group(1) else ''))
                if 0 < v <= 200: out['percentual'] = v; break
            except ValueError: pass
    if out['percentual'] is None:
        m = re.search(R_PROP, t) or re.search(R_PROP2, t)
        if m and int(m.group(2)) > 0:
            n = _PALAVRAS.get(m.group(1)) or int(m.group(1))
            out['percentual'] = round(n / int(m.group(2)) * 100, 6)
    for rx in R_DATACOM:
        m = re.search(rx, t)
        if m: out['dataCom'] = data_br(m.group(1)); break
    return out

# ── empresas → códigos de negociação (da base de proventos) ─────────────────
def mapa_tickers():
    mp = {}
    for f in glob.glob(os.path.join(RAIZ, 'dados', 'proventos', 'br', '*.json')):
        try: d = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        c = str(d.get('codigoCVM') or '').lstrip('0')
        if c and d.get('ticker') and (d.get('tipoAtivo') or 'acao') != 'fii': mp.setdefault(c, set()).add(d['ticker'])
    return {k: sorted(v) for k, v in mp.items()}

def ler_ipe(ano):
    z = zipfile.ZipFile(io.BytesIO(baixar(URL_IPE.format(a=ano))))
    nome = [n for n in z.namelist() if n.lower().endswith('.csv')][0]
    txt = z.read(nome).decode('latin-1')
    return list(csv.DictReader(io.StringIO(txt), delimiter=';'))

def main():
    hoje = datetime.date.today()
    anos = list(range(hoje.year - 1, hoje.year + 1)) if MODO == 'atualizar' else list(range(ANO_INICIO, hoje.year + 1))
    tickers = mapa_tickers()
    print(f'Modo {MODO}; anos {anos[0]}..{anos[-1]}; {len(tickers)} empresas com código de negociação')
    base = {'eventos': []}
    if os.path.exists(SAIDA):
        try: base = json.load(open(SAIDA, encoding='utf-8'))
        except Exception: pass
    estado = {'lidos': []}
    if os.path.exists(ESTADO):
        try: estado = json.load(open(ESTADO, encoding='utf-8'))
        except Exception: pass
    lidos = set(estado.get('lidos', []))
    eventos = {(e['codigoCVM'], e.get('protocolo')): e for e in base.get('eventos', [])}
    novos = revisar = falhas = baixados = achados = 0
    for ano in anos:
        try: linhas = ler_ipe(ano)
        except Exception as e:
            print(f'  {ano}: não consegui baixar o arquivo da CVM ({e})'); falhas += 1; continue
        cand = []
        for r in linhas:
            cat = sem_acento(r.get('Categoria'))
            if not any(c in cat for c in CATEGORIAS): continue
            assunto = sem_acento(' '.join([r.get('Assunto') or '', r.get('Tipo') or '', r.get('Especie') or '']))
            if 'bonific' not in assunto and not re.search(r'aumento\s+(?:do\s+|de\s+)?capital', assunto): continue
            cvm = str(r.get('Codigo_CVM') or '').lstrip('0')
            if cvm not in tickers: continue        # só empresas com ação negociada na nossa base
            cand.append(r)
        cand.sort(key=lambda r: 0 if 'bonific' in sem_acento(r.get('Assunto')) else 1)
        print(f'  {ano}: {len(linhas)} documentos, {len(cand)} candidatos ({sum(1 for r in cand if "bonific" in sem_acento(r.get("Assunto")))} com bonificação no assunto)')
        for r in cand:
            if (time.time() - T0) / 60 > LIMITE_MIN: print('Limite de tempo: grava o que fez e continua na próxima rodada.'); break
            prot = (r.get('Protocolo_Entrega') or '') + '-' + (r.get('Versao') or '')
            if prot in lidos: continue
            if MODO == 'diagnostico' and achados >= 15: break
            try:
                txt = texto_pdf(baixar(r['Link_Download'])); baixados += 1
            except Exception as e:
                print(f'    falhou {r.get("Nome_Companhia")} {r.get("Data_Entrega")}: {e}'); falhas += 1; continue
            lidos.add(prot)
            a = analisar(txt)
            if not a: continue
            achados += 1
            cvm = str(r.get('Codigo_CVM')).lstrip('0')
            st = 'sem-custo' if a['semCusto'] else ('ok' if a['custo'] is not None else 'revisar')
            ev = {'codigoCVM': cvm, 'empresa': r.get('Nome_Companhia'), 'tickers': tickers.get(cvm, []),
                  'dataDoc': (r.get('Data_Entrega') or '')[:10], 'categoria': r.get('Categoria'), 'protocolo': prot,
                  'link': r.get('Link_Download'), 'dataCom': a['dataCom'], 'percentual': a['percentual'],
                  'custo': a['custo'], 'semCusto': a['semCusto'], 'status': st, 'trecho': a['trecho']}
            if MODO == 'diagnostico':
                print('    DIAG', json.dumps({k: ev[k] for k in ('empresa', 'tickers', 'dataDoc', 'dataCom', 'percentual', 'custo', 'status', 'trecho')}, ensure_ascii=False))
                if st == 'revisar' or a['percentual'] is None or not a['dataCom']:
                    tn = re.sub(r'\s+', ' ', sem_acento(txt))
                    for pal in ('custo', 'bonific', 'posic'):
                        for m in list(re.finditer(pal, tn))[:3]:
                            print(f'       [{pal}] ...{tn[max(0, m.start() - 120):m.start() + 220]}...')
                continue
            eventos[(cvm, prot)] = ev; novos += 1
            if st == 'revisar': revisar += 1
            time.sleep(0.4)
    if MODO == 'diagnostico':
        print(f'Diagnóstico: {baixados} documentos baixados, {achados} falam de bonificação; nada gravado.'); return 0
    lista = sorted(eventos.values(), key=lambda e: (e.get('dataDoc') or '', e['empresa'] or ''))
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    json.dump({'atualizado': hoje.isoformat(), 'fonte': 'CVM, dados abertos (IPE): fatos relevantes e avisos aos acionistas',
               'eventos': lista}, open(SAIDA, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump({'lidos': sorted(lidos)}, open(ESTADO, 'w', encoding='utf-8'))
    ok = sum(1 for e in lista if e['status'] == 'ok')
    print(f'Pronto: {len(lista)} bonificações na base ({ok} com custo, {sum(1 for e in lista if e["status"] == "sem-custo")} sem custo atribuído, '
          f'{sum(1 for e in lista if e["status"] == "revisar")} a revisar); {novos} novas nesta rodada; {falhas} falhas de download.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
