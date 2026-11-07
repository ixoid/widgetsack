import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import ServerCheck from './ServerCheck';
import { createTelemetryHub, type TelemetryHub } from '../../../core/telemetry';
import { TelemetryHubContext } from '../../telemetryContext';

const NOW = 1_700_000_000_000;

function renderCard(props: Record<string, unknown> = {}) {
	const hub = createTelemetryHub();
	const utils = render(
		<TelemetryHubContext.Provider value={hub}>
			<ServerCheck title="Servers" now={() => NOW} {...props} />
		</TelemetryHubContext.Provider>
	);
	return { hub, ...utils };
}

function feed(hub: TelemetryHub, rows: unknown[]) {
	act(() => {
		hub.ingest({ sensor: 'srv.list', ts_ms: NOW, value: { kind: 'json', value: rows } });
	});
}

const ROWS = [
	{
		id: 'vps',
		name: 'VPS',
		kind: 'tcp',
		up: true,
		ms: 12.4,
		reason: '',
		downSince: null,
		history: [10, 11, 12.4]
	},
	{
		id: 'nas',
		name: 'NAS',
		kind: 'icmp',
		up: false,
		ms: null,
		reason: 'no echo reply',
		downSince: NOW - 7 * 60_000,
		history: [3, null]
	},
	{
		id: 'cam',
		name: 'Camera',
		kind: 'http',
		up: true,
		ms: 400,
		reason: '',
		downSince: null,
		history: []
	},
	{
		id: 'new',
		name: 'New',
		kind: 'tcp',
		up: null,
		ms: null,
		reason: '',
		downSince: null,
		history: []
	}
];

describe('ServerCheck', () => {
	it('shows the empty hint until rows arrive, then one row per target with level + value', () => {
		const { hub, container, getByText } = renderCard();
		expect(getByText(/No targets/)).toBeTruthy();
		expect(getByText('Servers')).toBeTruthy();
		feed(hub, ROWS);
		const rows = container.querySelectorAll('.srvc-row');
		expect(rows).toHaveLength(4);
		expect(rows[0].getAttribute('data-level')).toBe('up');
		expect(rows[0].querySelector('[data-part="value"]')?.textContent).toBe('12 ms');
		expect(rows[0].querySelector('[data-part="spark"]')).toBeTruthy();
		expect(rows[1].getAttribute('data-level')).toBe('down');
		expect(rows[1].querySelector('[data-part="value"]')?.textContent).toBe('down 7 min');
		expect(rows[1].querySelector('.srvc-name')?.getAttribute('title')).toBe('no echo reply');
		expect(rows[2].getAttribute('data-level')).toBe('slow');
		expect(rows[2].querySelector('[data-part="spark"]')).toBeNull(); // <2 points
		expect(rows[3].getAttribute('data-level')).toBe('unknown');
		expect(rows[3].querySelector('[data-part="value"]')?.textContent).toBe('—');
	});

	it('honours maxRows, showSparkline, slowMs and the accent colour', () => {
		const { hub, container } = renderCard({
			maxRows: 2,
			showSparkline: false,
			slowMs: 10,
			color: '#abc',
			title: ''
		});
		feed(hub, ROWS);
		const rows = container.querySelectorAll('.srvc-row');
		expect(rows).toHaveLength(2);
		expect(rows[0].getAttribute('data-level')).toBe('slow');
		expect(container.querySelector('[data-part="spark"]')).toBeNull();
		expect(container.querySelector('.srvc-head')).toBeNull();
		expect((container.firstChild as HTMLElement).style.getPropertyValue('--srvc-accent')).toBe(
			'#abc'
		);
	});

	it('falls back to "down" when a down row carries no downSince, and ignores non-json values', () => {
		const { hub, container } = renderCard();
		feed(hub, [{ ...ROWS[1], downSince: null }]);
		expect(container.querySelector('[data-part="value"]')?.textContent).toBe('down');
		// The same rows again are a no-op (no re-render churn on every poll).
		feed(hub, [{ ...ROWS[1], downSince: null }]);
		expect(container.querySelectorAll('.srvc-row')).toHaveLength(1);
		act(() => {
			hub.ingest({ sensor: 'srv.list', ts_ms: NOW, value: { kind: 'text', value: 'nope' } });
		});
		expect(container.querySelector('[data-part="empty"]')).toBeTruthy();
	});

	it('renders the empty state without a hub', () => {
		const { getByText } = render(<ServerCheck />);
		expect(getByText(/No targets/)).toBeTruthy();
	});
});
