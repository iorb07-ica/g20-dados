#!/usr/bin/env python3
"""
Agenda de pagamentos de proventos do Brasil e dos EUA (out/2026) para o push dos caraminguás.

Lê a base dados/proventos/br/*.json (montada por proventos_br.mjs no passo anterior)
e grava dados/proventos/agenda.json só com os pagamentos de 7 dias atrás até 120 dias
para frente, agrupados pela data de pagamento:
  {"atualizado": "AAAA-MM-DD", "br": {"AAAA-MM-DD": [{"t": "PETR4", "tipo": "JCP",
    "dataCom": "AAAA-MM-DD", "valor": 0.67}]}}
Desde a base dos EUA (proventos_us.py), também "us": {"AAAA-MM-DD": [{"t": "DELL", "ex": ..., "valor": 0.63, "tipo": "CD"}]}
O servidor (g20-proxy, push-notify, rotina das 9h) lê este arquivo uma vez por dia e,
para cada aluno, soma o que ele tinha de cada ativo na data com. Assim o aluno recebe o
aviso mesmo sem abrir a plataforma há tempos. Arquivo pequeno (algumas centenas de linhas).
"""
import datetime, glob, json, os

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SAIDA = os.path.join(RAIZ, 'dados', 'proventos', 'agenda.json')

def main():
    hoje = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)).date()
    ini, fim = (hoje - datetime.timedelta(days=7)).isoformat(), (hoje + datetime.timedelta(days=120)).isoformat()
    br, n = {}, 0
    for f in sorted(glob.glob(os.path.join(RAIZ, 'dados', 'proventos', 'br', '*.json'))):
        try: d = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        t = d.get('ticker')
        if not t: continue
        visto = set()
        for p in d.get('proventos', []):
            dp = p.get('dataPag') or ''
            if p.get('pagEstimado') or p.get('lote') or not (ini <= dp <= fim): continue
            v = p.get('valor')
            if not isinstance(v, (int, float)) or v <= 0: continue
            k = (p.get('tipo'), p.get('dataCom'), round(v, 8), dp)
            if k in visto: continue
            visto.add(k)
            br.setdefault(dp, []).append({'t': t, 'tipo': p.get('tipo') or 'DIV', 'dataCom': p.get('dataCom') or dp, 'valor': v})
            n += 1
    us, nu = {}, 0
    for f in sorted(glob.glob(os.path.join(RAIZ, 'dados', 'proventos', 'us', '*.json'))):
        try: d = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        t = d.get('ticker')
        if not t: continue
        for p in d.get('proventos', []):
            dp = p.get('pag') or ''
            if not (ini <= dp <= fim) or not isinstance(p.get('valor'), (int, float)) or p['valor'] <= 0: continue
            us.setdefault(dp, []).append({'t': t, 'ex': p.get('ex'), 'valor': p['valor'], 'tipo': p.get('tipo') or 'CD'})
            nu += 1
    out = {'atualizado': hoje.isoformat(), 'fonte': 'B3 (dados/proventos/br) e Polygon (dados/proventos/us)',
           'br': {k: br[k] for k in sorted(br)}, 'us': {k: us[k] for k in sorted(us)}}
    json.dump(out, open(SAIDA, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'Agenda: {n} pagamentos no Brasil em {len(br)} dias e {nu} nos EUA em {len(us)} dias ({ini} a {fim}).')

if __name__ == '__main__':
    main()
