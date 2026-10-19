#!/usr/bin/env python3
"""
Índices do Banco Central para a Plataforma G20 (out/2026).

Baixa as séries do SGS do Banco Central uma vez por dia e grava em dados/bcb/:
  sgs-<serie>.json   série inteira desde 2000:
                     {serie, inicio, ate, ate_bcb, fonte, atualizado, dados:[[aaaa-mm-dd, "valor"], ...]}
  ultimos.json       os 12 últimos pontos de cada série (para os pedidos "ultimos/N")
                     e a data em que cada série foi conferida com sucesso

As páginas leem esses arquivos direto do GitHub Pages pelo g20-sidebar.js, sem
passar pela Vercel.

B3 (out/2026): a tarefa também guarda, a cada rodada,
  b3-cdi.json        taxa DI oficial de cada dia (% ao ano), direto da B3 (FTP da antiga Cetip),
                     montada aos poucos: os dias mais recentes primeiro, até ~10 min por rodada
  b3-indice-XXX.json fechamento diário dos índices da B3 (IBOV, IFIX, IDIV, SMLL) desde 2000
  A taxa DI da B3 é a fonte oficial do CDI: quando o BCB recusa, o CDI diário (12) e o CDI
  mensal (4391) saem dela, e não mais da aproximação pela Selic.

Fonte principal: Banco Central. Quando ele recusa (como em 18 e 19/10/2026, em que
o filtro de segurança do BCB rejeitava todo mundo), usa uma fonte reserva gratuita
do governo, sem chave:
  IPEADATA  dólar comercial venda (série 1), Selic over (séries 11 e 12),
            meta Selic (432), CDI mensal (4391), IGP-M (189)
  IBGE      IPCA mensal (433) e IPCA em 12 meses (13522), fonte original do índice
Poupança (195) não tem reserva: fica como estava até o BCB voltar.

Regras da reserva:
  - nunca sobrescreve dado que veio do BCB; só acrescenta dias depois do último dado do BCB
  - série gravada só pela reserva fica marcada (fonte "reserva") e, quando o BCB voltar,
    é baixada inteira de novo dele e substituída
  - CDI diário (12) pela reserva é calculado como Selic over menos 0,10 ponto ao ano,
    a diferença usual entre as duas taxas; o BCB corrige quando voltar
  - se a reserva trouxer número fora da faixa esperada, é descartada

Séries:
  1     dólar comercial (venda)          189   IGP-M (% ao mês)
  11    Selic diária (% ao dia)           195   poupança (% no período)
  12    CDI diário (% ao dia)             432   meta Selic (% ao ano)
  433   IPCA (% ao mês)                   4391  CDI mensal (% ao mês)
  13522 IPCA acumulado em 12 meses

Roda pela tarefa .github/workflows/bcb-indices.yml.
Só biblioteca padrão do Python: nada para instalar.
"""
import base64, datetime, ftplib, functools, json, os, time, urllib.request, urllib.error

# Registro aparece na hora na aba Actions (sem isso, uma rodada cancelada não mostra nada)
print = functools.partial(print, flush=True)

SERIES = [1, 11, 12, 189, 195, 432, 433, 4391, 13522]
INICIO = datetime.date(2000, 1, 1)
REVISAO_DIAS = 45          # rebusca o fim da série: o BCB às vezes corrige dados recentes
BLOCO_ANOS = 5             # a API limita janelas longas em séries diárias
ULTIMOS = 12
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dados', 'bcb')
URL_BCB = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.{s}/dados?formato=json&dataInicial={di}&dataFinal={df}'
URL_IPEA = "http://www.ipeadata.gov.br/api/odata4/ValoresSerie(SERCODIGO='{c}')"
URL_SIDRA = 'https://apisidra.ibge.gov.br/values/t/1737/n1/all/v/{v}/p/all'
CABECALHOS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
}


# ───────────────────────── utilidades ─────────────────────────
def br(d):
    return d.strftime('%d/%m/%Y')


def iso_de_br(s):
    d, m, a = s.strip().split('/')
    return f'{a}-{m}-{d}'


class Recusado(Exception):
    """O site respondeu com uma página (bloqueio ou manutenção) no lugar dos dados."""


def baixar_json(url, aceita_404=False, timeout=25, tentativas=3):
    req = urllib.request.Request(url, headers=CABECALHOS)
    ultimo_erro = None
    for tentativa in range(tentativas):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                bruto = r.read().decode('utf-8', 'replace')
            try:
                return json.loads(bruto)
            except ValueError:
                # Página no lugar dos dados: tentar de novo na hora não adianta
                trecho = ' '.join(bruto.split())[:160]
                raise Recusado(f'não veio JSON: {trecho}')
        except Recusado:
            raise
        except urllib.error.HTTPError as e:
            if e.code == 404 and aceita_404:
                return []
            ultimo_erro = f'HTTP {e.code}'
        except Exception as e:  # tempo esgotado, rede
            ultimo_erro = str(e)[:260]
        if tentativa < tentativas - 1:
            time.sleep(3 * (tentativa + 1))
    raise RuntimeError(ultimo_erro or 'falhou')


# Se o BCB falhar em duas séries seguidas (recusa ou demora), as demais vão direto para a reserva nesta rodada
BCB_RECUSAS = {'n': 0}
BCB_LIMITE = 2


def ler(caminho):
    try:
        with open(caminho, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def gravar(caminho, obj):
    with open(caminho, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def agora_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ───────────────────────── Banco Central ─────────────────────────
def blocos(de, ate):
    ini = de
    while ini <= ate:
        try:
            fim = ini.replace(year=ini.year + BLOCO_ANOS) - datetime.timedelta(days=1)
        except ValueError:  # 29/02
            fim = ini.replace(year=ini.year + BLOCO_ANOS, day=28)
        fim = min(fim, ate)
        yield ini, fim
        ini = fim + datetime.timedelta(days=1)


def do_bcb(serie, de, ate):
    if BCB_RECUSAS['n'] >= BCB_LIMITE:
        raise Recusado('BCB falhou nas séries anteriores nesta rodada; indo direto para a reserva')
    pontos = {}
    for a, b in blocos(de, ate):
        dados = baixar_json(URL_BCB.format(s=serie, di=br(a), df=br(b)), aceita_404=True, timeout=20, tentativas=2)
        if not isinstance(dados, list):
            raise ValueError('resposta inesperada do BCB')
        for x in dados:
            try:
                d = iso_de_br(x['data'])
                v = str(x['valor']).strip()
                float(v)
            except Exception:
                continue
            pontos[d] = v
        time.sleep(0.6)
    return pontos


# ───────────────────────── reserva: IPEADATA e IBGE ─────────────────────────
_cache_reserva = {}


def ipea(codigo):
    if codigo not in _cache_reserva:
        j = baixar_json(URL_IPEA.format(c=codigo), timeout=60, tentativas=2)
        lista = j.get('value') if isinstance(j, dict) else None
        if not isinstance(lista, list):
            raise ValueError(f'IPEADATA {codigo}: resposta inesperada')
        out = {}
        for x in lista:
            v, d = x.get('VALVALOR'), str(x.get('VALDATA') or '')[:10]
            if v is None or len(d) != 10 or d < INICIO.isoformat():
                continue
            out[d] = float(v)
        if not out:
            raise ValueError(f'IPEADATA {codigo}: série vazia')
        _cache_reserva[codigo] = out
    return _cache_reserva[codigo]


def sidra(variavel):
    chave = f'sidra-{variavel}'
    if chave not in _cache_reserva:
        j = baixar_json(URL_SIDRA.format(v=variavel), timeout=60, tentativas=2)
        if not isinstance(j, list) or len(j) < 2:
            raise ValueError(f'IBGE {variavel}: resposta inesperada')
        cab = j[0]
        col_mes = next((k for k, t in cab.items() if str(t).startswith('Mês (Código)')), None)
        if not col_mes:
            raise ValueError(f'IBGE {variavel}: coluna do mês não encontrada')
        out = {}
        for x in j[1:]:
            p, v = str(x.get(col_mes, '')), str(x.get('V', '')).strip()
            if len(p) != 6:
                continue
            try:
                num = float(v)
            except ValueError:
                continue  # "..." ou "-": sem dado
            d = f'{p[:4]}-{p[4:]}-01'
            if d >= INICIO.isoformat():
                out[d] = num
        if not out:
            raise ValueError(f'IBGE {variavel}: série vazia')
        _cache_reserva[chave] = out
    return _cache_reserva[chave]


def ao_dia(taxa_aa):
    return ((1 + taxa_aa / 100.0) ** (1 / 252.0) - 1) * 100.0


# ───────────────────────── B3: taxa DI e índices ─────────────────────────
B3_FTP_HOST = 'ftp.cetip.com.br'
B3_FTP_PASTA = 'MediaCDI'
B3_FTP_LIMITE_S = 600          # tempo máximo de FTP por rodada; o resto fica para as próximas
B3_INDICES = {'IBOV': 2000, 'IFIX': 2011, 'IDIV': 2006, 'SMLL': 2008}
URL_B3_INDICE = 'https://sistemaswebb3-listados.b3.com.br/indexStatisticsProxy/IndexCall/GetPortfolioDay/{q}'
CAB_B3 = dict(CABECALHOS, Referer='https://www.b3.com.br/', Origin='https://www.b3.com.br')
_b3_cdi = {}                   # {aaaa-mm-dd: taxa % ao ano}, preenchido por b3_atualizar_cdi()


def b3_atualizar_cdi(hoje):
    """Completa dados/bcb/b3-cdi.json com a taxa DI de cada dia útil, pelo FTP da B3 (Cetip)."""
    caminho = os.path.join(SAIDA, 'b3-cdi.json')
    antigo = ler(caminho) or {}
    taxas = dict(antigo.get('taxas') or {})
    sem = set(antigo.get('sem_taxa') or [])      # feriados e dias sem arquivo: não pede de novo
    t0 = time.time()
    novos = 0
    try:
        ftp = ftplib.FTP(B3_FTP_HOST, timeout=30)
        ftp.login()
        ftp.cwd(B3_FTP_PASTA)
        nomes = {os.path.basename(n) for n in ftp.nlst()}
        meses_no_ftp = {n[:6] for n in nomes if len(n) >= 12 and n[:8].isdigit()}
    except Exception as e:
        print(f'::warning::B3 (taxa DI): FTP não respondeu ({str(e)[:160]}); CDI segue pela reserva anterior')
        _b3_cdi.update({d: float(v) for d, v in taxas.items()})
        return
    # dias que faltam, do mais recente para o mais antigo
    faltam = []
    d = hoje
    while d >= INICIO:
        iso = d.isoformat()
        if d.weekday() < 5 and iso not in taxas and iso not in sem:
            faltam.append(d)
        d -= datetime.timedelta(days=1)
    exemplo = None
    for d in faltam:
        if time.time() - t0 > B3_FTP_LIMITE_S:
            break
        nome = d.strftime('%Y%m%d') + '.txt'
        iso = d.isoformat()
        if nome not in nomes:
            # só considera feriado se o FTP tem outros dias do mesmo mês (lista completa daquele mês)
            if d < hoje - datetime.timedelta(days=7) and nome[:6] in meses_no_ftp:
                sem.add(iso)
            continue
        partes = []
        try:
            ftp.retrbinary('RETR ' + nome, partes.append)
        except Exception as e:
            print(f'::warning::B3 (taxa DI): falhou ao ler {nome} ({str(e)[:120]}); continua na próxima rodada')
            break
        bruto = b''.join(partes).decode('latin-1').strip()
        try:
            taxa = int(bruto.split()[0]) / 100.0
        except Exception:
            print(f'::warning::B3 (taxa DI): conteúdo inesperado em {nome}: {bruto[:60]!r}')
            break
        if not (0.5 <= taxa <= 60):
            print(f'::warning::B3 (taxa DI): {nome} trouxe {taxa} (fora da faixa); descartado')
            break
        if exemplo is None:
            exemplo = f'{nome} = {bruto!r} -> {taxa:.2f}% ao ano'
        taxas[iso] = f'{taxa:.2f}'
        novos += 1
    try:
        ftp.quit()
    except Exception:
        pass
    if novos or len(sem) != len(antigo.get('sem_taxa') or []):
        gravar(caminho, {'fonte': 'B3 (FTP Cetip, MediaCDI)', 'atualizado': agora_utc(),
                         'taxas': dict(sorted(taxas.items())), 'sem_taxa': sorted(sem)})
    _b3_cdi.update({d: float(v) for d, v in taxas.items()})
    restantes = sum(1 for d in faltam if d.isoformat() not in taxas and d.isoformat() not in sem)
    print(f'B3 (taxa DI): {novos} dias novos em {time.time() - t0:.0f}s; base com {len(taxas)} dias'
          + (f', mais antigo {min(taxas)}' if taxas else '') + f'; faltam {restantes}'
          + (f'; exemplo {exemplo}' if exemplo else ''))


def _num_br(v):
    if v is None:
        return None
    t = str(v).strip().replace('.', '').replace(',', '.')
    try:
        return float(t)
    except ValueError:
        return None


def b3_atualizar_indices(hoje):
    """Grava dados/bcb/b3-indice-XXX.json com o fechamento diário de cada índice da B3."""
    for idx, desde in B3_INDICES.items():
        caminho = os.path.join(SAIDA, f'b3-indice-{idx}.json')
        antigo = ler(caminho) or {}
        pontos = {d: v for d, v in (antigo.get('dados') or [])}
        anos = [hoje.year] if pontos else list(range(max(desde, INICIO.year), hoje.year + 1))
        if pontos and hoje.month == 1:
            anos = [hoje.year - 1, hoje.year]
        try:
            novos = 0
            for ano in anos:
                q = base64.b64encode(json.dumps({'index': idx, 'language': 'pt-br', 'year': str(ano)}).encode()).decode()
                req = urllib.request.Request(URL_B3_INDICE.format(q=q), headers=CAB_B3)
                with urllib.request.urlopen(req, timeout=30) as r:
                    bruto = r.read().decode('utf-8', 'replace')
                try:
                    j = json.loads(bruto)
                except ValueError:
                    raise RuntimeError('não veio JSON: ' + ' '.join(bruto.split())[:140])
                linhas = j.get('results') if isinstance(j, dict) else None
                if not isinstance(linhas, list):
                    raise RuntimeError('formato inesperado: ' + json.dumps(j)[:200])
                for ln in linhas:
                    dia = ln.get('day')
                    for m in range(1, 13):
                        v = _num_br(ln.get(f'rateValue{m}'))
                        if not dia or v is None or v <= 0:
                            continue
                        try:
                            d = datetime.date(ano, m, int(dia)).isoformat()
                        except ValueError:
                            continue
                        txt = f'{v:.2f}'
                        if pontos.get(d) != txt:
                            novos += 1
                        pontos[d] = txt
                time.sleep(0.5)
            if not pontos:
                raise RuntimeError('nenhum fechamento encontrado')
            if novos:
                datas = sorted(pontos)
                gravar(caminho, {'indice': idx, 'fonte': 'B3', 'atualizado': agora_utc(), 'ate': datas[-1],
                                 'dados': [[d, pontos[d]] for d in datas]})
            print(f'B3 índice {idx}: ok, {len(pontos)} dias, até {max(pontos)}, {novos} novos')
        except Exception as e:
            print(f'::warning::B3 índice {idx}: falhou ({str(e)[:220]}); fica como estava')


def cdi_b3_ou_aprox():
    """CDI diário (% ao dia) pela taxa DI da B3; dias que a B3 ainda não tem saem da Selic menos 0,10."""
    out = {}
    try:
        selic = ipea('GM366_TJOVER366')
    except Exception:
        selic = {}
    for d, v in selic.items():
        out[d] = f'{ao_dia(max(v - 0.10, 0.0)):.6f}'
    for d, v in _b3_cdi.items():
        out[d] = f'{ao_dia(v):.6f}'
    if not out:
        raise RuntimeError('nem B3 nem IPEADATA responderam')
    return out


def cdi_mensal_b3_ou_ipea():
    """CDI do mês (% ao mês) composto a partir da taxa DI diária da B3, só para meses completos na base."""
    if not _b3_cdi:
        return {d: f'{v:.2f}' for d, v in ipea('BM12_TJCDI12').items()}
    por_mes = {}
    for d, v in _b3_cdi.items():
        por_mes.setdefault(d[:7], []).append((d, v))
    base_ipea = {}
    try:
        base_ipea = {d: f'{v:.2f}' for d, v in ipea('BM12_TJCDI12').items()}
    except Exception:
        pass
    out = dict(base_ipea)
    mais_antigo = min(_b3_cdi)
    for mes, dias in por_mes.items():
        if mes + '-01' <= mais_antigo[:7] + '-01':
            continue                              # primeiro mês da base pode estar incompleto
        fator = 1.0
        for _, v in dias:
            fator *= 1 + ao_dia(v) / 100.0
        out[mes + '-01'] = f'{(fator - 1) * 100:.2f}'
    return out


# Cada reserva devolve {data: "valor"} no mesmo formato e unidade do BCB.
RESERVAS = {
    1:     {'nome': 'IPEADATA dólar comercial venda', 'faixa': (1.0, 15.0),
            'f': lambda: {d: f'{v:.4f}' for d, v in ipea('GM366_ERV366').items()}},
    11:    {'nome': 'IPEADATA Selic over', 'faixa': (0.0, 0.2),
            'f': lambda: {d: f'{ao_dia(v):.6f}' for d, v in ipea('GM366_TJOVER366').items()}},
    12:    {'nome': 'B3 taxa DI (dias ainda sem B3: Selic over menos 0,10)', 'faixa': (0.0, 0.2),
            'f': cdi_b3_ou_aprox},
    432:   {'nome': 'IPEADATA meta Selic do Copom', 'faixa': (1.0, 50.0),
            'f': lambda: {d: f'{v:.2f}' for d, v in ipea('BM366_TJOVER366').items()}},
    4391:  {'nome': 'B3 taxa DI composta no mês (meses sem B3: IPEADATA)', 'faixa': (0.0, 5.0),
            'f': cdi_mensal_b3_ou_ipea},
    189:   {'nome': 'IPEADATA IGP-M', 'faixa': (-10.0, 15.0),
            'f': lambda: {d: f'{v:.2f}' for d, v in ipea('IGP12_IGPMG12').items()}},
    433:   {'nome': 'IBGE IPCA mensal', 'faixa': (-5.0, 10.0),
            'f': lambda: {d: f'{v:.2f}' for d, v in sidra(63).items()}},
    13522: {'nome': 'IBGE IPCA em 12 meses', 'faixa': (-5.0, 50.0),
            'f': lambda: {d: f'{v:.2f}' for d, v in sidra(2265).items()}},
}


MENSAIS = {189, 433, 4391, 13522}


def da_reserva(serie):
    r = RESERVAS.get(serie)
    if not r:
        raise RuntimeError('sem fonte reserva para esta série')
    pontos = r['f']()
    if serie in MENSAIS:
        # o BCB só publica o mês fechado; o IPEADATA traz o mês corrente parcial (ex.: CDI de outubro até hoje)
        mes_atual = datetime.date.today().replace(day=1).isoformat()
        pontos = {d: v for d, v in pontos.items() if d < mes_atual}
    if not pontos:
        raise RuntimeError(f'{r["nome"]}: sem dados')
    ultimo = float(pontos[max(pontos)])
    lo, hi = r['faixa']
    if not (lo <= ultimo <= hi):
        raise RuntimeError(f'{r["nome"]}: valor {ultimo} fora da faixa esperada ({lo} a {hi}); descartado')
    return pontos, r['nome']


# ───────────────────────── uma série ─────────────────────────
def atualizar(serie, hoje):
    """Devolve (obj, como) com como = 'bcb', 'reserva' ou 'igual'. Levanta erro se nada deu certo."""
    caminho = os.path.join(SAIDA, f'sgs-{serie}.json')
    antigo = ler(caminho)
    tem_antigo = bool(antigo and isinstance(antigo.get('dados'), list) and antigo['dados'])
    fonte_antiga = (antigo or {}).get('fonte', 'bcb') if tem_antigo else None
    pontos = {d: v for d, v in antigo['dados']} if tem_antigo else {}
    ate_bcb = (antigo or {}).get('ate_bcb') if tem_antigo else None
    if tem_antigo and fonte_antiga == 'bcb' and not ate_bcb:
        ate_bcb = antigo.get('ate')  # arquivos da primeira versão

    # 1) Banco Central
    erro_bcb = None
    try:
        if fonte_antiga == 'bcb' and ate_bcb:
            de = max(INICIO, datetime.date.fromisoformat(ate_bcb) - datetime.timedelta(days=REVISAO_DIAS))
            novos = do_bcb(serie, de, hoje)
            base = pontos
        else:
            # sem arquivo, ou arquivo feito só pela reserva: baixa tudo do BCB e substitui
            novos = do_bcb(serie, INICIO, hoje)
            base = {}
        BCB_RECUSAS['n'] = 0
        if not novos and not base:
            raise RuntimeError('BCB devolveu série vazia')
        mudou = fonte_antiga != 'bcb' or any(base.get(d) != v for d, v in novos.items())
        base.update(novos)
        datas = sorted(base)
        ate_novo = max([ate_bcb or ''] + list(novos.keys())) or datas[-1]
        if tem_antigo and not mudou:
            return antigo, 'igual'
        obj = {'serie': serie, 'inicio': INICIO.isoformat(), 'ate': datas[-1], 'ate_bcb': ate_novo,
               'fonte': 'bcb', 'atualizado': agora_utc(), 'dados': [[d, base[d]] for d in datas]}
        gravar(caminho, obj)
        return obj, 'bcb'
    except Exception as e:
        # recusa ou tempo esgotado: os dois contam para pular o BCB no resto da rodada
        BCB_RECUSAS['n'] += 1
        erro_bcb = str(e)

    # 2) Reserva
    try:
        reserva, nome = da_reserva(serie)
    except Exception as e:
        raise RuntimeError(f'BCB: {erro_bcb} | reserva: {e}')
    if fonte_antiga == 'bcb':
        # nunca mexe no que veio do BCB: só acrescenta os dias depois do último dado dele
        corte = ate_bcb or (max(pontos) if pontos else '')
        acrescimo = {d: v for d, v in reserva.items() if d > corte}
        if not acrescimo or all(pontos.get(d) == v for d, v in acrescimo.items()):
            print(f'  série {serie}: BCB falhou ({erro_bcb[:120]}); reserva sem dias novos depois de {corte}')
            return antigo, 'igual'
        pontos.update(acrescimo)
        datas = sorted(pontos)
        obj = dict(antigo, ate=datas[-1], ate_bcb=corte, fonte='bcb', atualizado=agora_utc(),
                   dados=[[d, pontos[d]] for d in datas])
    else:
        datas = sorted(reserva)
        if tem_antigo and {d: v for d, v in antigo['dados']} == reserva:
            return antigo, 'igual'
        obj = {'serie': serie, 'inicio': INICIO.isoformat(), 'ate': datas[-1], 'ate_bcb': None,
               'fonte': 'reserva', 'fonte_nome': nome, 'atualizado': agora_utc(),
               'dados': [[d, reserva[d]] for d in datas]}
    gravar(caminho, obj)
    print(f'::warning::série {serie}: BCB recusou ({erro_bcb[:120]}); usada a reserva {nome}, até {obj["ate"]}')
    return obj, 'reserva'


def main():
    os.makedirs(SAIDA, exist_ok=True)
    hoje = datetime.date.today()
    # B3 primeiro: a taxa DI dela alimenta a reserva do CDI; os índices ficam guardados para as páginas
    try:
        b3_atualizar_cdi(hoje)
    except Exception as e:
        print(f'::warning::B3 (taxa DI): erro inesperado ({str(e)[:200]})')
    try:
        b3_atualizar_indices(hoje)
    except Exception as e:
        print(f'::warning::B3 índices: erro inesperado ({str(e)[:200]})')
    resumo, falhas, conferidas, por_reserva = {}, [], [], []
    for s in SERIES:
        t0 = time.time()
        print(f'série {s}: começando')
        try:
            obj, como = atualizar(s, hoje)
            resumo[str(s)] = obj['dados'][-ULTIMOS:]
            conferidas.append(s)
            if como == 'reserva':
                por_reserva.append(s)
            print(f'série {s}: ok ({como}), até {obj["ate"]}, {len(obj["dados"])} pontos, fonte {obj.get("fonte", "bcb")}, {time.time() - t0:.0f}s')
        except Exception as e:
            falhas.append(s)
            antigo = ler(os.path.join(SAIDA, f'sgs-{s}.json'))
            if antigo and antigo.get('dados'):
                resumo[str(s)] = antigo['dados'][-ULTIMOS:]
            print(f'::warning::série {s}: falhou ({str(e)[:300]}); fica como estava e tenta de novo na próxima rodada')
    if resumo:
        caminho = os.path.join(SAIDA, 'ultimos.json')
        antigo = ler(caminho) or {}
        conferido = dict(antigo.get('conferido') or {})
        for s in conferidas:
            conferido[str(s)] = hoje.isoformat()
        gravar(caminho, {'atualizado': agora_utc(), 'series': resumo, 'conferido': conferido})
    saida = os.environ.get('GITHUB_OUTPUT')
    if saida:
        with open(saida, 'a') as f:
            f.write(f'falhas={len(falhas)}\n')
    print(f'Fim: {len(conferidas)} de {len(SERIES)} séries em dia '
          f'({len(conferidas) - len(por_reserva)} pelo BCB ou sem novidade, {len(por_reserva)} pela reserva); '
          f'{len(falhas)} falharam.')


if __name__ == '__main__':
    main()
