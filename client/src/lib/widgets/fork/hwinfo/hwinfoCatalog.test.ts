import { describe, expect, it } from 'vitest';
import {
	HW_CPU_CLOCK_MAX_ID,
	HW_CPU_POWER_ID,
	HW_CPU_TEMP_ID,
	HW_STATUS_ID,
	WELL_KNOWN_ENTRIES,
	backendLabel,
	catalogEntries,
	clampPollSeconds,
	filterReadings,
	formatReading,
	toggleSlug
} from './hwinfoCatalog';
import type { HwinfoReading, HwinfoStatus } from './hwinfo-types';

const cpu = 'CPU [#0]: AMD Ryzen 9 9950X3D: Enhanced';
const gpu = 'GPU [#0]: NVIDIA GeForce RTX 5090';
const readings: HwinfoReading[] = [
	{
		slug: 'core-clocks',
		id: 'hw.core-clocks',
		label: 'Core Clocks',
		sensor: cpu,
		unit: 'MHz',
		value: 3605.2
	},
	{
		slug: 'cpu-tctl-tdie',
		id: 'hw.cpu-tctl-tdie',
		label: 'CPU (Tctl/Tdie)',
		sensor: cpu,
		unit: '°C',
		value: 63.8
	},
	{
		slug: 'gpu-power',
		id: 'hw.gpu-power',
		label: 'GPU Power',
		sensor: gpu,
		unit: 'W',
		value: 70.5
	},
	{
		slug: 'gpu-core-load',
		id: 'hw.gpu-core-load',
		label: 'GPU Core Load',
		sensor: gpu,
		unit: '',
		value: 4
	}
];
const status: HwinfoStatus = {
	configured: true,
	pollSeconds: 2,
	enabled: ['gpu-power', 'missing-slug'],
	running: true,
	backend: 'registry',
	gadgetEnabled: true,
	detail: '10 readings',
	readings
};

describe('hwinfoCatalog', () => {
	it('well-known ids mirror the Rust model', () => {
		expect(WELL_KNOWN_ENTRIES.map((e) => e.id)).toEqual([
			HW_STATUS_ID,
			HW_CPU_TEMP_ID,
			HW_CPU_CLOCK_MAX_ID,
			HW_CPU_POWER_ID
		]);
		expect(HW_STATUS_ID).toBe('hw.status');
		expect(HW_CPU_TEMP_ID).toBe('hw.cpu.temp');
	});

	it('catalogEntries lists the well-known ids plus only the ENABLED readings', () => {
		expect(catalogEntries(null)).toEqual(WELL_KNOWN_ENTRIES);
		const ids = catalogEntries(status).map((e) => e.id);
		expect(ids).toEqual([...WELL_KNOWN_ENTRIES.map((e) => e.id), 'hw.gpu-power']);
		const gpuPower = catalogEntries(status).find((e) => e.id === 'hw.gpu-power');
		expect(gpuPower).toEqual({ id: 'hw.gpu-power', label: 'GPU Power', unit: 'W' });
		// An empty unit becomes undefined so the dropdown shows no stray separator.
		const unitless = catalogEntries({ ...status, enabled: ['gpu-core-load'] }).at(-1);
		expect(unitless).toEqual({ id: 'hw.gpu-core-load', label: 'GPU Core Load', unit: undefined });
		// Returns a fresh array — callers may mutate it without touching the constant.
		expect(catalogEntries(null)).not.toBe(WELL_KNOWN_ENTRIES);
	});

	it('filterReadings matches label, sensor or id, case-insensitively', () => {
		expect(filterReadings(readings, '')).toBe(readings);
		expect(filterReadings(readings, '   ')).toBe(readings);
		expect(filterReadings(readings, 'GPU').map((r) => r.slug)).toEqual([
			'gpu-power',
			'gpu-core-load'
		]);
		expect(filterReadings(readings, 'tctl').map((r) => r.slug)).toEqual(['cpu-tctl-tdie']);
		expect(filterReadings(readings, 'ryzen').map((r) => r.slug)).toEqual([
			'core-clocks',
			'cpu-tctl-tdie'
		]);
		expect(filterReadings(readings, 'hw.core-')).toHaveLength(1);
		expect(filterReadings(readings, 'nothing')).toEqual([]);
	});

	it('toggleSlug adds or removes without mutating', () => {
		const enabled = ['a', 'b'];
		expect(toggleSlug(enabled, 'c')).toEqual(['a', 'b', 'c']);
		expect(toggleSlug(enabled, 'a')).toEqual(['b']);
		expect(enabled).toEqual(['a', 'b']);
	});

	it('formatReading keeps integers and rounds the rest to one decimal', () => {
		expect(formatReading(3605.26, 'MHz')).toBe('3605.3 MHz');
		expect(formatReading(4, '%')).toBe('4 %');
		expect(formatReading(63.8, '°C')).toBe('63.8 °C');
		expect(formatReading(12, '')).toBe('12');
		expect(formatReading(0.25, '')).toBe('0.3');
	});

	it('backendLabel names the interface', () => {
		expect(backendLabel('shared-memory')).toBe('Shared memory');
		expect(backendLabel('registry')).toBe('Gadget registry');
		expect(backendLabel('none')).toBe('Not available');
	});

	it('clampPollSeconds bounds and rounds, defaulting garbage to 2', () => {
		expect(clampPollSeconds(0)).toBe(1);
		expect(clampPollSeconds(2.4)).toBe(2);
		expect(clampPollSeconds(999)).toBe(60);
		expect(clampPollSeconds(Number.NaN)).toBe(2);
		expect(clampPollSeconds(Number.POSITIVE_INFINITY)).toBe(2);
	});
});
