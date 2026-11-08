import Icon from '../Icon';
import { useSettingsOperations } from './useSettingsOperations';
// The stocks plugin's settings pane (studio → Plugins → Stocks). A container (AGENTS.md §6): owns the
// symbol/interval form and drives the Tauri commands via stocks-commands.ts. The live badge reads the
// `stocks.status` telemetry sample through the hub (reusing the HA status→badge mapping). Below the
// form, the configured symbols' bindable `stocks.<SYMBOL>.*` ids are listed with copy-id. Reuses the
// shared `has-*` settings styles (loaded by the HA plugin).
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import { copyToClipboard } from '../../overlay';
import {
	saveStocksConfig,
	stocksConfigStatus,
	stocksConnect,
	stocksReconnect
} from './stocks-commands';
import { refreshStocksCatalog, stocksSource } from './stocks-source';
import { parseSymbols } from './stocks-symbols';
import {
	normalizeStocksProvider,
	STOCKS_PROVIDER_OPTIONS,
	stocksProviderNote,
	stocksSymbolHelp
} from './stocks-provider';
import type { StocksProvider } from './stocks-types';
import TokenListField from './TokenListField';

export default function StocksSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'stocks.status');
	const badge = haStatusBadge(status.value?.kind === 'text' ? status.value.value : null);

	const [provider, setProvider] = useState<StocksProvider>('yahoo');
	const [symbols, setSymbols] = useState<string[]>([]);
	const [pollSeconds, setPollSeconds] = useState(60);
	const [configured, setConfigured] = useState(false);
	const { saving, saved, error: saveError, invalidate, capture, save } = useSettingsOperations();

	useEffect(() => {
		let alive = true;
		const current = capture();
		stocksConnect().catch(() => undefined);
		stocksConfigStatus()
			.then((s) => {
				if (!alive || !current()) return;
				setProvider(normalizeStocksProvider(s.provider));
				setSymbols(s.symbols);
				setPollSeconds(s.pollSeconds);
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [capture]);

	const dirtied = invalidate;
	const canSubmit = !saving;

	const onSave = async () => {
		/* v8 ignore next -- the only Save control is disabled for invalid or in-flight submissions. */
		if (!canSubmit) return;
		await save(
			async () => {
				await saveStocksConfig({ provider, symbols, pollSeconds });
				await stocksReconnect();
				await refreshStocksCatalog();
			},
			() => setConfigured(symbols.length > 0)
		);
	};
	const ids = stocksSource.catalogEntries?.() ?? [];

	return (
		<div className="has">
			{saveError && <div className="has-test err">Couldn’t save: {saveError}</div>}
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">{configured ? 'configured' : 'not configured'}</span>
			</div>

			<div className="rp-hd">Provider</div>
			<label className="has-field">
				Stocks provider
				<select
					value={provider}
					aria-describedby="stocks-provider-hint"
					onChange={(e) => {
						setProvider(normalizeStocksProvider(e.currentTarget.value));
						dirtied();
					}}
				>
					{STOCKS_PROVIDER_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</label>

			<div className="rp-hd">Symbols</div>
			<div className="has-help" id="stocks-provider-hint">
				{stocksSymbolHelp(provider)} Add a <strong>Stock Ticker</strong> widget and select its
				symbol. You can also bind <code>stocks.&lt;SYMBOL&gt;.*</code> sensors to other widgets.
			</div>

			<TokenListField
				label="Tickers"
				values={symbols}
				onChange={(next) => {
					setSymbols(next);
					dirtied();
				}}
				parse={parseSymbols}
				placeholder="AAPL — Enter to add, or paste a comma/newline list"
				listLabel="Tickers"
				emptyHint="No tickers yet — type one above and press Enter."
			/>

			<label className="has-field">
				Poll interval (seconds)
				<input
					type="number"
					min={15}
					max={3600}
					step={5}
					value={pollSeconds}
					onChange={(e) => {
						setPollSeconds(Number(e.currentTarget.value) || 60);
						dirtied();
					}}
				/>
			</label>

			<div className="has-warn">
				<Icon name="alert" /> {stocksProviderNote(provider)}
			</div>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!canSubmit}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & refresh'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>

			<div className="rp-hd">Sensors</div>
			<div className="has-help">
				This list shows sensor IDs for your symbols. Copy an ID. Use it in a Text, Gauge, or
				Sparkline widget.
			</div>
			{symbols.length ? (
				<ul className="has-entities" aria-label="Stock sensors">
					{ids.map((e) => (
						<li key={e.id} className="has-entity">
							<span className="has-entity-name" title={e.id}>
								{e.label ?? e.id}
							</span>
							<code className="has-entity-id" title={e.id}>
								{e.id}
							</code>
							<button
								type="button"
								className="has-copy"
								title="Copy sensor id"
								aria-label={`Copy sensor id ${e.id}`}
								onClick={() => void copyToClipboard(e.id)}
							>
								⧉
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="has-help">No symbols yet — add some above and save.</div>
			)}
		</div>
	);
}
