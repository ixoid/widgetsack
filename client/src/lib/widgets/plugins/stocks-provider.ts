// Pure helpers for the stocks provider select: status normalisation and the per-provider copy.
// Kept out of StocksSettings.tsx so the pane stays small and the mapping is unit-tested.
import type { StocksProvider } from './stocks-types';

export const STOCKS_PROVIDER_OPTIONS: readonly { value: StocksProvider; label: string }[] = [
	{ value: 'yahoo', label: 'Yahoo Finance' },
	{ value: 'cbr-binance', label: 'CBR + Binance' }
];

/** Anything the backend returns that is not the CBR + Binance value is treated as Yahoo (its default). */
export const normalizeStocksProvider = (value: string): StocksProvider =>
	value === 'cbr-binance' ? 'cbr-binance' : 'yahoo';

/** Symbol help under the Tickers heading; a plain string so it is testable without rendering. */
export const stocksSymbolHelp = (provider: StocksProvider): string =>
	provider === 'cbr-binance'
		? 'Quotes come from the Bank of Russia (CBR) and Binance. No API key is needed. Supported symbols: USDRUB, USDRUB=X, EURRUB=X (any 3-letter CBR currency code + RUB), and BTC-USD, BTCUSDT or any other <COIN>-USD. Other symbols show a dash.'
		: 'Quotes come from Yahoo Finance. No API key is needed. Add symbols such as AAPL, BTC-USD, or ^GSPC.';

/** Warning/notice shown above Save; differs because the Yahoo endpoint is unofficial. */
export const stocksProviderNote = (provider: StocksProvider): string =>
	provider === 'cbr-binance'
		? 'CBR rates update once a day and are fetched at most every 30 min. Crypto change is a rolling 24h. Polling is paused automatically while no ticker is shown.'
		: 'Yahoo’s endpoint is unofficial and best-effort — it can rate-limit or change without notice. Polling is paused automatically while no ticker is shown.';
