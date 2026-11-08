import { describe, expect, it } from 'vitest';
import {
	normalizeStocksProvider,
	STOCKS_PROVIDER_OPTIONS,
	stocksProviderNote,
	stocksSymbolHelp
} from './stocks-provider';

describe('stocks-provider', () => {
	it('normalises only the exact cbr-binance value, everything else is yahoo', () => {
		expect(normalizeStocksProvider('cbr-binance')).toBe('cbr-binance');
		expect(normalizeStocksProvider('yahoo')).toBe('yahoo');
		expect(normalizeStocksProvider('bybit')).toBe('yahoo');
		expect(normalizeStocksProvider('')).toBe('yahoo');
	});

	it('offers both providers with human labels', () => {
		expect(STOCKS_PROVIDER_OPTIONS).toEqual([
			{ value: 'yahoo', label: 'Yahoo Finance' },
			{ value: 'cbr-binance', label: 'CBR + Binance' }
		]);
	});

	it('describes supported spellings for CBR + Binance and the Yahoo source otherwise', () => {
		expect(stocksSymbolHelp('cbr-binance')).toMatch(/USDRUB=X.*EURRUB=X.*BTC-USD.*BTCUSDT/);
		expect(stocksSymbolHelp('yahoo')).toMatch(/Yahoo Finance.*\^GSPC/);
	});

	it('warns about the unofficial endpoint only for Yahoo, and about cadence for CBR', () => {
		expect(stocksProviderNote('yahoo')).toMatch(/unofficial/);
		expect(stocksProviderNote('cbr-binance')).toMatch(/once a day.*30 min.*rolling 24h/);
		expect(stocksProviderNote('cbr-binance')).not.toMatch(/unofficial/);
	});
});
