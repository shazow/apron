import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMISSION_BUDGET, DEFAULT_LIMITS } from '../src/budget.ts';
import { renderBinding, renderEdgeRules, replaceBinding, validateAdmission } from './budget.mjs';

test('changed admission limits propagate to both Worker and optional edge policy', () => {
	const changed = { ...ADMISSION_BUDGET, requestsPerIpMinute: 25, edgeRequestsPerIpWindow: 20 };
	assert.match(renderBinding('123', changed), /limit = 25, period = 60/);
	const edge = renderEdgeRules('chat.example.test', changed);
	assert.equal(edge.optionalZoneRateLimit.rules[0].ratelimit.requests_per_period, 20);
	assert.equal(edge.optionalZoneRateLimit.rules[0].enabled, false);
	assert.match(edge.custom.rules[0].expression, /http.host eq "chat.example.test"/);
	assert.equal(edge.custom.rules[1].enabled, false);
});

test('generation is idempotent and preserves unrelated Wrangler settings', () => {
	const original = 'name = "example"\n[vars]\nADMISSION_OFF = "true"\n';
	const initial = replaceBinding(original, renderBinding('123'));
	assert.equal(replaceBinding(initial, renderBinding('123')), initial);
	const changed = replaceBinding(initial, renderBinding('456'));
	assert.ok(changed.startsWith(original));
	assert.match(changed, /namespace_id = "456"/);
	assert.doesNotMatch(changed, /namespace_id = "123"/);
});

test('invalid windows and inconsistent attempt budgets cannot be generated', () => {
	for (const requestsPerIpMinute of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, requestsPerIpMinute }));
	}
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, workerWindowSeconds: 10 }));
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, edgeWindowSeconds: 60 }));
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, edgeBlockSeconds: 60 }));
	assert.throws(() => validateAdmission(ADMISSION_BUDGET, {
		...DEFAULT_LIMITS, connectionAdmissionsPerIpMinute: ADMISSION_BUDGET.requestsPerIpMinute + 1,
	}));
});

test('malformed generated sections fail without rewriting configuration', () => {
	assert.throws(() => replaceBinding('# BEGIN GENERATED ADMISSION BUDGET\n', renderBinding('123')));
});
