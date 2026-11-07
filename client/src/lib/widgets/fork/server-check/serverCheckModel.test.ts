import { describe, expect, it } from 'vitest';
import {
	emptyTarget,
	formatDownSince,
	formatLatency,
	newTargetId,
	parseServerList,
	rowLevel,
	sparkHistory,
	targetProblem,
	targetSensorIds
} from './serverCheckModel';
import type { ServerCheckTarget } from './server-check-types';

const t = (over: Partial<ServerCheckTarget>): ServerCheckTarget => ({
	...emptyTarget('x'),
	host: 'nas.local',
	...over
});

describe('parseServerList', () => {
	it('shapes well-formed rows and fills defaults for missing fields', () => {
		const rows = parseServerList([
			{
				id: 'vps',
				name: 'VPS',
				kind: 'tcp',
				up: true,
				ms: 12.5,
				reason: '',
				downSince: null,
				history: [10, null, 12.5]
			},
			{ id: 'bare' }
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: 'vps', name: 'VPS', kind: 'tcp', up: true, ms: 12.5 });
		expect(rows[0].history).toEqual([10, null, 12.5]);
		expect(rows[1]).toEqual({
			id: 'bare',
			name: 'bare',
			kind: 'tcp',
			up: null,
			ms: null,
			reason: '',
			downSince: null,
			history: []
		});
	});

	it('drops non-arrays, non-objects, id-less rows and non-finite numbers', () => {
		expect(parseServerList(null)).toEqual([]);
		expect(parseServerList('x')).toEqual([]);
		const rows = parseServerList([
			null,
			'str',
			{ name: 'no id' },
			{ id: '' },
			{ id: 'ok', ms: NaN }
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0].ms).toBeNull();
		expect(parseServerList([{ id: 'k', kind: 'bogus', history: 'nope' }])[0]).toMatchObject({
			kind: 'tcp',
			history: []
		});
	});
});

describe('rowLevel', () => {
	it('classifies unknown / down / slow / up', () => {
		expect(rowLevel({ up: null, ms: null })).toBe('unknown');
		expect(rowLevel({ up: false, ms: null })).toBe('down');
		expect(rowLevel({ up: true, ms: 150 })).toBe('slow');
		expect(rowLevel({ up: true, ms: 149 })).toBe('up');
		expect(rowLevel({ up: true, ms: null })).toBe('up');
		expect(rowLevel({ up: true, ms: 50 }, 40)).toBe('slow');
	});
});

describe('formatters', () => {
	it('formatLatency rounds, floors sub-ms and dashes null', () => {
		expect(formatLatency(null)).toBe('—');
		expect(formatLatency(0.4)).toBe('<1 ms');
		expect(formatLatency(12.6)).toBe('13 ms');
	});

	it('formatDownSince is coarse and empty when not down', () => {
		const now = 1_000_000_000;
		expect(formatDownSince(null, now)).toBe('');
		expect(formatDownSince(now - 30_000, now)).toBe('down <1 min');
		expect(formatDownSince(now - 5 * 60_000, now)).toBe('down 5 min');
		expect(formatDownSince(now - 3 * 3_600_000, now)).toBe('down 3 h');
		expect(formatDownSince(now - 2 * 86_400_000, now)).toBe('down 2 d');
		expect(formatDownSince(now + 5000, now)).toBe('down <1 min'); // clock skew never goes negative
	});

	it('sparkHistory draws failed probes as 0', () => {
		expect(sparkHistory([10, null, 12])).toEqual([10, 0, 12]);
	});
});

describe('newTargetId', () => {
	it('slugs the name, caps the length and uniquifies', () => {
		expect(newTargetId('My VPS (prod)', [])).toBe('my-vps-prod');
		expect(newTargetId('   ', [])).toBe('target');
		expect(newTargetId('!!!', ['target'])).toBe('target-2');
		expect(newTargetId('a', ['a', 'a-2'])).toBe('a-3');
		expect(newTargetId('x'.repeat(40), [])).toHaveLength(24);
		expect(newTargetId('abcdefghijklmnopqrstuvw-xyz', [])).toBe('abcdefghijklmnopqrstuvw');
	});
});

describe('targetProblem', () => {
	it('accepts valid icmp / tcp / http targets', () => {
		expect(targetProblem(t({ kind: 'icmp' }))).toBeNull();
		expect(targetProblem(t({ kind: 'tcp', port: 22 }))).toBeNull();
		expect(targetProblem(t({ kind: 'http', url: 'https://example.org/health' }))).toBeNull();
		expect(
			targetProblem(t({ kind: 'http', url: 'http://10.0.0.1:8123/', expectStatus: 204 }))
		).toBeNull();
	});

	it('names the first problem', () => {
		expect(targetProblem(t({ host: '' }))).toMatch(/bare host/);
		expect(targetProblem(t({ host: 'http://x' }))).toMatch(/bare host/);
		expect(targetProblem(t({ host: 'a b' }))).toMatch(/bare host/);
		expect(targetProblem(t({ kind: 'tcp', port: 0 }))).toMatch(/Port/);
		expect(targetProblem(t({ kind: 'tcp', port: 70000 }))).toMatch(/Port/);
		expect(targetProblem(t({ kind: 'http', url: 'example.org' }))).toMatch(/http\(s\)/);
		expect(targetProblem(t({ kind: 'http', url: 'https://u:p@example.org' }))).toMatch(
			/credentials/
		);
		expect(targetProblem(t({ kind: 'http', url: 'https://e.org', expectStatus: 42 }))).toMatch(
			/status/
		);
		expect(targetProblem(t({ intervalSecs: 1 }))).toMatch(/Interval/);
		expect(targetProblem(t({ timeoutMs: 10 }))).toMatch(/Timeout/);
	});
});

describe('targetSensorIds / emptyTarget', () => {
	it('exposes the four per-target ids and backend defaults', () => {
		expect(targetSensorIds('vps').map((e) => e.id)).toEqual([
			'srv.vps.up',
			'srv.vps.ms',
			'srv.vps.status',
			'srv.vps.lastDown'
		]);
		expect(emptyTarget('n')).toMatchObject({
			id: 'n',
			kind: 'icmp',
			intervalSecs: 30,
			timeoutMs: 3000
		});
	});
});
