import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADMISSION_BUDGET, DEFAULT_LIMITS } from '../src/budget.ts';
import { loadConfig } from '../src/config.ts';

const root = new URL('../', import.meta.url);
const begin = '# BEGIN GENERATED ADMISSION BUDGET';
const end = '# END GENERATED ADMISSION BUDGET';

export function validateAdmission(admission = ADMISSION_BUDGET, limits = DEFAULT_LIMITS) {
	for (const [name, value] of Object.entries(admission)) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	}
	if (admission.workerWindowSeconds !== 60) throw new Error('Worker attempt budget is per minute');
	if (admission.requestsPerIpMinute < limits.connectionAdmissionsPerIpMinute) {
		throw new Error('Attempt budget must allow the configured per-IP connection admissions');
	}
	if (admission.edgeWindowSeconds !== 10 || admission.edgeBlockSeconds !== 10) {
		throw new Error('Free WAF supports only 10-second counting and mitigation windows');
	}
}

export function renderBinding(namespace, admission = ADMISSION_BUDGET) {
	validateAdmission(admission);
	return `${begin}
# Edit src/budget.ts, then run npm run budget:generate.
[[ratelimits]]
name = "CONNECTION_ATTEMPTS"
namespace_id = "${namespace}"
simple = { limit = ${admission.requestsPerIpMinute}, period = ${admission.workerWindowSeconds} }
${end}`;
}

export function renderEdgeRules(hostname, admission = ADMISSION_BUDGET) {
	validateAdmission(admission);
	const host = `http.host eq ${JSON.stringify(hostname)}`;
	return {
		custom: {
			phase: 'http_request_firewall_custom',
			rules: [
				{
					ref: 'apron_invalid_request',
					description: 'Apron: reject invalid WebSocket handshakes before Worker invocation',
					expression: `(${host}) and (http.request.method ne "GET" or not http.request.uri.path in {"/" "/ws"} or not any(lower(http.request.headers["upgrade"][*])[*] eq "websocket"))`,
					action: 'block', enabled: true,
				},
				{
					ref: 'apron_admission_off',
					description: 'Apron: emergency admission shutdown (enable manually)',
					expression: host,
					action: 'block', enabled: false,
				},
			],
		},
		// Free WAF cannot scope a rate-limiting rule by hostname. Keep this
		// optional rule disabled until its effect on the entire zone is approved.
		optionalZoneRateLimit: {
			phase: 'http_ratelimit',
			rules: [{
				ref: 'apron_connection_attempts',
				description: 'Optional: limits / and /ws across ALL hostnames in the zone',
				expression: 'http.request.uri.path in {"/" "/ws"}',
				action: 'block', enabled: false,
				ratelimit: {
					characteristics: ['cf.colo.id', 'ip.src'],
					period: admission.edgeWindowSeconds,
					requests_per_period: admission.edgeRequestsPerIpWindow,
					mitigation_timeout: admission.edgeBlockSeconds,
				},
			}],
		},
	};
}

export function replaceBinding(source, binding) {
	if (source.includes(begin)) {
		const start = source.indexOf(begin);
		const finish = source.indexOf(end, start);
		if (finish < 0 || source.indexOf(begin, start + begin.length) >= 0) throw new Error('Malformed generated budget block');
		return source.slice(0, start) + binding + source.slice(finish + end.length);
	}
	return `${source.trimEnd()}\n\n${binding}\n`;
}

function topLevelConfig(source) {
	const firstTable = source.search(/^\s*\[/m);
	return source.slice(0, firstTable < 0 ? source.length : firstTable);
}

function configName(source, file) {
	const match = topLevelConfig(source).match(/^name\s*=\s*"([^"]+)"\s*$/m);
	if (!match) throw new Error(`${file} must define a Worker name`);
	return match[1];
}

export function validateDeploymentConfiguration({ development, production, packageJson, makefile }) {
	const developmentName = configName(development, 'wrangler.toml');
	const productionName = configName(production, 'wrangler.production.toml');
	const productionTopLevel = topLevelConfig(production);
	if (developmentName === productionName) {
		throw new Error('Development and production Worker names must be distinct');
	}
	if (!/^workers_dev\s*=\s*false\s*(?:#.*)?$/m.test(productionTopLevel)) {
		throw new Error('Production Wrangler config must disable workers.dev');
	}
	if (!/^preview_urls\s*=\s*false\s*(?:#.*)?$/m.test(productionTopLevel)) {
		throw new Error('Production Wrangler config must disable preview URLs');
	}
	if (/^\[assets\]\s*(?:#.*)?$/m.test(production)) {
		throw new Error('Production Worker must not bind static assets');
	}
	if (!/pattern\s*=\s*"server\.apron\.chat"\s*,\s*custom_domain\s*=\s*true/.test(productionTopLevel)) {
		throw new Error('Production Wrangler config must use the server custom domain');
	}
	if (!packageJson?.scripts?.deploy?.includes('--config wrangler.production.toml')) {
		throw new Error('The package deploy script must select wrangler.production.toml');
	}
	if (!/deploy-worker:\s*\n\s*npm --prefix servers\/cloudflare-worker run deploy/.test(makefile ?? '')) {
		throw new Error('The Makefile deploy-worker target must use the guarded package deploy script');
	}
}

function main() {
	const check = process.argv[2] === '--check';
	if (process.argv.length > (check ? 3 : 2)) throw new Error('Usage: node scripts/budget.mjs [--check]');
	validateAdmission();
	loadConfig({ NODE_ENV: 'test' });
	const development = readFileSync(new URL('wrangler.toml', root), 'utf8');
	const production = readFileSync(new URL('wrangler.production.toml', root), 'utf8');
	const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
	const makefile = readFileSync(new URL('../../Makefile', root), 'utf8');
	validateDeploymentConfiguration({ development, production, packageJson, makefile });
	const outputs = [];
	for (const [file, namespace] of [['wrangler.toml', '73001'], ['wrangler.production.toml', '73002']]) {
		const source = readFileSync(new URL(file, root), 'utf8');
		outputs.push([file, replaceBinding(source, renderBinding(namespace))]);
	}
	const hosts = [...production.matchAll(/pattern\s*=\s*"([a-z0-9.-]+)"\s*,\s*custom_domain\s*=\s*true/g)];
	if (hosts.length !== 1) throw new Error('Expected exactly one production custom domain');
	outputs.push(['docs/edge-rules.generated.json', JSON.stringify(renderEdgeRules(hosts[0][1]), null, 2) + '\n']);
	let stale = false;
	for (const [file, expected] of outputs) {
		const path = new URL(file, root);
		let actual;
		try { actual = readFileSync(path, 'utf8'); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		if (actual === expected) continue;
		if (check) {
			console.error(`${file} is stale; run npm run budget:generate`);
			stale = true;
		} else {
			writeFileSync(path, expected);
			console.log(`Generated ${file}`);
		}
	}
	if (stale) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
