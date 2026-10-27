// ==========================================================================
// tickers-source.js  ·  Lista de tickers para o coletor de logos
// --------------------------------------------------------------------------
// Alimenta o fetch-tradingview-logos.js.
//
// COMO EDITAR:
//   - Adicione/remova tickers livremente. Um por entrada, entre aspas.
//   - Pode digitar com ou sem .SA — o sufixo e removido automaticamente.
//   - Repetidos sao ignorados (dedup automatico).
//   - Cripto (BTC, ETH...) NAO precisa entrar: o script ja preserva sozinho.
//
// Conteudo: Carteira G20 + carteira pessoal + S&P 500 completo (503 acoes).
// Total: 620 tickers.
// ==========================================================================

module.exports = [

  // ===== Acoes / Units / FIIs BR (Carteira G20 + pessoal) =====
  'ITUB4', 'BBDC4', 'BBAS3', 'ABEV3', 'B3SA3', 'GGBR4', 'BBSE3', 'EQTL3',
  'SBSP3', 'KLBN11', 'VIVT3', 'MULT3', 'HAPV3', 'TOTS3', 'EMBR3', 'PETR3',
  'PRIO3', 'VALE3', 'PETR4', 'BPAC11', 'SBFG3', 'RENT3', 'VIVA3', 'INTB3',
  'BMOB3', 'LREN3', 'WEGE3', 'SAPR11', 'RADL3', 'VULC3', 'AZZA3', 'MGLU3',
  'CVCB3', 'ENEV3', 'WIZC3', 'BRAV3', 'AUAU3', 'QUAL3', 'BRKM5', 'EGIE3',
  'GMAT3', 'SUZB3', 'CMIG4', 'TRIS3', 'NATU3', 'VRTA11', 'BCRI11', 'TVRI11',
  'BTHF11', 'HGLG11', 'VISC11', 'KNRI11', 'XPLG11', 'RBRR11', 'HCTR11',
  'KNCA11', 'CPTR11', 'SNAG11', 'XPCA11',

  // ===== S&P 500 (503 acoes) =====
  'MMM', 'AOS', 'ABT', 'ABBV', 'ACN', 'ADBE', 'AMD', 'AES', 'AFL', 'A', 'APD',
  'ABNB', 'AKAM', 'ALB', 'ARE', 'ALGN', 'ALLE', 'LNT', 'ALL', 'GOOGL', 'GOOG',
  'MO', 'AMZN', 'AMCR', 'AEE', 'AEP', 'AXP', 'AIG', 'AMT', 'AWK', 'AMP',
  'AME', 'AMGN', 'APH', 'ADI', 'AON', 'APA', 'APO', 'AAPL', 'AMAT', 'APP',
  'APTV', 'ACGL', 'ADM', 'ARES', 'ANET', 'AJG', 'AIZ', 'T', 'ATO', 'ADSK',
  'ADP', 'AZO', 'AVB', 'AVY', 'AXON', 'BKR', 'BALL', 'BAC', 'BAX', 'BDX',
  'BRK.B', 'BBY', 'TECH', 'BIIB', 'BLK', 'BX', 'XYZ', 'BK', 'BA', 'BKNG',
  'BSX', 'BMY', 'AVGO', 'BR', 'BRO', 'BF.B', 'BLDR', 'BG', 'BXP', 'CHRW',
  'CDNS', 'CPT', 'CPB', 'COF', 'CAH', 'CCL', 'CARR', 'CVNA', 'CAT', 'CBOE',
  'CBRE', 'CDW', 'COR', 'CNC', 'CNP', 'CF', 'CRL', 'SCHW', 'CHTR', 'CVX',
  'CMG', 'CB', 'CHD', 'CIEN', 'CI', 'CINF', 'CTAS', 'CSCO', 'C', 'CFG', 'CLX',
  'CME', 'CMS', 'KO', 'CTSH', 'COIN', 'CL', 'CMCSA', 'FIX', 'CAG', 'COP',
  'ED', 'STZ', 'CEG', 'COO', 'CPRT', 'GLW', 'CPAY', 'CTVA', 'CSGP', 'COST',
  'CTRA', 'CRH', 'CRWD', 'CCI', 'CSX', 'CMI', 'CVS', 'DHR', 'DRI', 'DDOG',
  'DVA', 'DECK', 'DE', 'DELL', 'DAL', 'DVN', 'DXCM', 'FANG', 'DLR', 'DG',
  'DLTR', 'D', 'DPZ', 'DASH', 'DOV', 'DOW', 'DHI', 'DTE', 'DUK', 'DD', 'ETN',
  'EBAY', 'ECL', 'EIX', 'EW', 'EA', 'ELV', 'EME', 'EMR', 'ETR', 'EOG', 'EPAM',
  'EQT', 'EFX', 'EQIX', 'EQR', 'ERIE', 'ESS', 'EL', 'EG', 'EVRG', 'ES', 'EXC',
  'EXE', 'EXPE', 'EXPD', 'EXR', 'XOM', 'FFIV', 'FDS', 'FICO', 'FAST', 'FRT',
  'FDX', 'FIS', 'FITB', 'FSLR', 'FE', 'FISV', 'F', 'FTNT', 'FTV', 'FOXA',
  'FOX', 'BEN', 'FCX', 'GRMN', 'IT', 'GE', 'GEHC', 'GEV', 'GEN', 'GNRC', 'GD',
  'GIS', 'GM', 'GPC', 'GILD', 'GPN', 'GL', 'GDDY', 'GS', 'HAL', 'HIG', 'HAS',
  'HCA', 'DOC', 'HSIC', 'HSY', 'HPE', 'HLT', 'HOLX', 'HD', 'HON', 'HRL',
  'HST', 'HWM', 'HPQ', 'HUBB', 'HUM', 'HBAN', 'HII', 'IBM', 'IEX', 'IDXX',
  'ITW', 'INCY', 'IR', 'PODD', 'INTC', 'IBKR', 'ICE', 'IFF', 'IP', 'INTU',
  'ISRG', 'IVZ', 'INVH', 'IQV', 'IRM', 'JBHT', 'JBL', 'JKHY', 'J', 'JNJ',
  'JCI', 'JPM', 'KVUE', 'KDP', 'KEY', 'KEYS', 'KMB', 'KIM', 'KMI', 'KKR',
  'KLAC', 'KHC', 'KR', 'LHX', 'LH', 'LRCX', 'LW', 'LVS', 'LDOS', 'LEN', 'LII',
  'LLY', 'LIN', 'LYV', 'LMT', 'L', 'LOW', 'LULU', 'LYB', 'MTB', 'MPC', 'MAR',
  'MMC', 'MLM', 'MAS', 'MA', 'MTCH', 'MKC', 'MCD', 'MCK', 'MDT', 'MRK',
  'META', 'MET', 'MTD', 'MGM', 'MCHP', 'MU', 'MSFT', 'MAA', 'MRNA', 'MOH',
  'TAP', 'MDLZ', 'MPWR', 'MNST', 'MCO', 'MS', 'MOS', 'MSI', 'MSCI', 'NDAQ',
  'NTAP', 'NFLX', 'NEM', 'NWSA', 'NWS', 'NEE', 'NKE', 'NI', 'NDSN', 'NSC',
  'NTRS', 'NOC', 'NCLH', 'NRG', 'NUE', 'NVDA', 'NVR', 'NXPI', 'ORLY', 'OXY',
  'ODFL', 'OMC', 'ON', 'OKE', 'ORCL', 'OTIS', 'PCAR', 'PKG', 'PLTR', 'PANW',
  'PSKY', 'PH', 'PAYX', 'PAYC', 'PYPL', 'PNR', 'PEP', 'PFE', 'PCG', 'PM',
  'PSX', 'PNW', 'PNC', 'POOL', 'PPG', 'PPL', 'PFG', 'PG', 'PGR', 'PLD', 'PRU',
  'PEG', 'PTC', 'PSA', 'PHM', 'PWR', 'QCOM', 'DGX', 'Q', 'RL', 'RJF', 'RTX',
  'O', 'REG', 'REGN', 'RF', 'RSG', 'RMD', 'RVTY', 'HOOD', 'ROK', 'ROL', 'ROP',
  'ROST', 'RCL', 'SPGI', 'CRM', 'SNDK', 'SBAC', 'SLB', 'STX', 'SRE', 'NOW',
  'SHW', 'SPG', 'SWKS', 'SJM', 'SW', 'SNA', 'SOLV', 'SO', 'LUV', 'SWK',
  'SBUX', 'STT', 'STLD', 'STE', 'SYK', 'SMCI', 'SYF', 'SNPS', 'SYY', 'TMUS',
  'TROW', 'TTWO', 'TPR', 'TRGP', 'TGT', 'TEL', 'TDY', 'TER', 'TSLA', 'TXN',
  'TPL', 'TXT', 'TMO', 'TJX', 'TKO', 'TTD', 'TSCO', 'TT', 'TDG', 'TRV',
  'TRMB', 'TFC', 'TYL', 'TSN', 'USB', 'UBER', 'UDR', 'ULTA', 'UNP', 'UAL',
  'UPS', 'URI', 'UNH', 'UHS', 'VLO', 'VTR', 'VLTO', 'VRSN', 'VRSK', 'VZ',
  'VRTX', 'VTRS', 'VICI', 'V', 'VST', 'VMC', 'WRB', 'GWW', 'WAB', 'WMT',
  'DIS', 'WBD', 'WM', 'WAT', 'WEC', 'WFC', 'WELL', 'WST', 'WDC', 'WY', 'WSM',
  'WMB', 'WTW', 'WDAY', 'WYNN', 'XEL', 'XYL', 'YUM', 'ZBRA', 'ZBH', 'ZTS',

  // ===== Outros US / ADRs / ETFs (fora do S&P 500) =====
  'STNE', 'INTR', 'TSM', 'ASML', 'XP', 'MELI', 'BABA', 'NU', 'CROX', 'NVO',
  'QBTS', 'RGTI', 'ANF', 'DUOL', 'ENPH', 'SPOT', 'MP', 'DKS', 'USAR', 'ONON',
  'LEU', 'LEVI', 'EU', 'CASY', 'TGLS', 'TXRH', 'RACE', 'ZGN', 'KNSL', 'LMND',
  'GGAL', 'IREN', 'NBIS', 'BMA', 'PDD', 'VCX', 'ACMR', 'SHOP', 'BBW', 'SKT',
  'SLG', 'IIPR', 'NNN', 'QYLD', 'XYLD', 'URA', 'MCHI', 'SCHA', 'XLU', 'XBI',
  'QQQ', 'ARGT', 'CIBR', 'IEUR', 'NOBL', 'HERO', 'VNQ', 'ARKG',

  // ===== >>> ADICIONE NOVOS TICKERS A PARTIR DAQUI <<< =====

];
