// Decode a layout JSON file with the real document decoder and report what the app would do with it.
// Usage (from client/): npx vite-node scripts/check-layout.ts <path-to-layout.json>
// Exit 1 when the file would be rejected or recovered, or when a widget type/config key is unknown.
import { readFileSync } from 'node:fs';
import { decodeLayoutDocument } from '../src/lib/core/layoutDocument';
import { getMeta } from '../src/lib/core/widget';
import type { LayoutNode } from '../src/lib/core/layoutTree';
import { registerBuiltinPlugins } from '../src/lib/widgets/plugins';

// Plugin widget types (weather, agenda, rss, ha.*, …) register lazily; built-in metas load with widget.ts.
registerBuiltinPlugins();

const path = process.argv[2];
if (!path) {
	console.error('usage: vite-node scripts/check-layout.ts <layout.json>');
	process.exit(2);
}
const decoded = decodeLayoutDocument(readFileSync(path, 'utf8'));
const { layout: _layout, raw: _raw, ...summary } = decoded as Record<string, unknown>;
console.log('decode:', JSON.stringify(summary));
if (decoded.kind !== 'valid') process.exit(1);

let units = 0;
let problems = 0;
const walk = (node: LayoutNode, trail: string): void => {
	if ('children' in node) {
		for (const c of node.children) walk(c, `${trail}/${node.id}`);
		return;
	}
	const unit = node.unit;
	if ('kind' in unit && unit.kind === 'group') {
		walk(unit.child, `${trail}/${unit.id}`);
		return;
	}
	units++;
	const meta = getMeta(unit.type);
	if (!meta) {
		problems++;
		console.log(`UNKNOWN TYPE ${unit.type} at ${trail}/${unit.id}`);
		return;
	}
	const known = new Set((meta.configFields ?? []).map((f) => f.key));
	for (const key of Object.keys(unit.config ?? {})) {
		if (!known.has(key) && !(key in (meta.defaultConfig ?? {}))) {
			problems++;
			console.log(`unknown config key "${key}" for ${unit.type} at ${trail}/${unit.id}`);
		}
	}
	if (meta.binds && meta.binds !== 'none' && !unit.sensor && !meta.sensors) {
		console.log(`note: ${unit.type} ${unit.id} has no sensor (uses default ${meta.defaultSensor})`);
	}
};
for (const [monitor, layout] of Object.entries(decoded.layout.monitors)) {
	walk(layout.root, monitor);
	for (const f of layout.floating) walk(f, `${monitor}/floating`);
}
console.log(`units: ${units}, problems: ${problems}`);
process.exit(problems ? 1 : 0);
