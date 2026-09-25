import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openChat } from './test-helpers';

/**
 * Journey: switching between two rooms and back. Starts on the click on a
 * room in the sidebar, ends at the first frame painted after the other room's
 * messages are in place and scrolled to the latest.
 *
 * Counts come from Chrome (style recalculations, layouts, DOM nodes) and from
 * a MutationObserver (elements inserted); wall clock is measured with the CPU
 * throttled to a phone-like 4x.
 *
 * The counts are the same on every run, so each has a ceiling in
 * `perf-ceilings.json` that a change may not raise. When a change lowers one,
 * `PERF_UPDATE=1` writes the new value there: wins become the new floor.
 */

const MESSAGES_PER_ROOM = 200;
const ROUND_TRIPS = 10;
const CPU_THROTTLE = 4;

type Reply = { id?: string; result?: Record<string, unknown>; error?: unknown };

/** A minimal protocol peer for seeding: one guest, request/response only. */
async function guest(name: string): Promise<{ call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void }> {
	const socket = new WebSocket('ws://127.0.0.1:8090/ws');
	const waiting = new Map<string, (reply: Reply) => void>();
	let next = 0;
	socket.addEventListener('message', (event) => {
		const frame = JSON.parse(String(event.data)) as Reply;
		if (frame.id && waiting.has(frame.id)) {
			waiting.get(frame.id)!(frame);
			waiting.delete(frame.id);
		}
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	const call = (method: string, params: Record<string, unknown>) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const id = `s${++next}`;
			waiting.set(id, (reply) => (reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result ?? {})));
			socket.send(JSON.stringify({ method, id, params }));
		});
	await call('auth', { scheme: 'guest', name });
	return { call, close: () => socket.close() };
}

/** Chat as people write it: runs of messages per sender, some Markdown, links, code and mentions. */
function body(index: number, mention: string): { text: string; format?: 'markdown' } {
	switch (index % 6) {
		case 0: return { text: `Morning! Picking up where we left off on item ${index}.` };
		case 1: return { text: `Here's the plan for **step ${index}**:\n\n- read the [spec](https://example.com/spec/${index})\n- run \`make test\`\n- ship it`, format: 'markdown' };
		case 2: return { text: `@${mention} can you take a look at this one? It's the ${index}th time the build flaked.`, format: 'markdown' };
		case 3: return { text: '```\nfunction retry(attempts) {\n  return attempts > 3 ? fail() : again();\n}\n```\nThat should do it.', format: 'markdown' };
		case 4: return { text: `> quoting the earlier message ${index - 1}\n\nAgreed — *mostly*. One caveat about ${index}.`, format: 'markdown' };
		default: return { text: `ok 👍 ${index}` };
	}
}

async function seed(): Promise<{ perfRoom: string; first: Record<string, string>; last: Record<string, string> }> {
	const people = await Promise.all(['Ada', 'Bo', 'Cy'].map(guest));
	const { room_id: perfRoom } = await people[0].call('room_set', { title: 'Perf' });
	const first: Record<string, string> = {};
	const last: Record<string, string> = {};
	for (const room of ['general', perfRoom as string]) {
		for (let index = 0; index < MESSAGES_PER_ROOM; index++) {
			const sender = people[Math.floor(index / 3) % people.length];
			const result = await sender.call('message', { room_id: room, body: body(index, 'guest') });
			first[room] ??= result.message_id as string;
			last[room] = result.message_id as string;
		}
	}
	for (const person of people) person.close();
	return { perfRoom: perfRoom as string, first, last };
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
	const { metrics } = await cdp.send('Performance.getMetrics');
	return Object.fromEntries(metrics.map(({ name, value }: { name: string; value: number }) => [name, value]));
}

/**
 * Clicks a room and times the first painted frame, which must hold its latest
 * message, and the frame in which its oldest message is in place too.
 * Counts elements inserted, descendants included, up to the first frame.
 */
async function switchTo(page: Page, room: string, first: string, last: string): Promise<{ ms: number; completeMs: number; inserted: number }> {
	return page.evaluate(async ({ room, first, last }) => {
		let inserted = 0;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) if (node instanceof Element) inserted += 1 + node.getElementsByTagName('*').length;
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
		// Asked for before the click, so this runs ahead of any frame callback the switch schedules.
		const painted = new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		const start = performance.now();
		document.querySelector<HTMLButtonElement>(`[data-testid="room-list"] button[data-room="${room}"]`)!.click();
		await painted;
		const ms = performance.now() - start;
		observer.disconnect();
		if (!document.querySelector(`article[data-message-id="${last}"]`)) throw new Error(`room ${room} did not render its latest message`);
		while (!document.querySelector(`article[data-message-id="${first}"]`)) await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		return { ms, completeMs: performance.now() - start, inserted };
	}, { room, first, last });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const CEILINGS = new URL('./perf-ceilings.json', import.meta.url);

/** Fails when a count rose above its ceiling; lowers the ceiling under `PERF_UPDATE=1`. */
function ratchet(name: string, value: number): void {
	const ceilings = JSON.parse(readFileSync(CEILINGS, 'utf8')) as Record<string, number>;
	const ceiling = ceilings[name];
	if ((ceiling === undefined || value < ceiling) && process.env.PERF_UPDATE) {
		writeFileSync(CEILINGS, `${JSON.stringify({ ...ceilings, [name]: value }, null, '\t')}\n`);
		return;
	}
	expect(ceiling, `no ceiling for "${name}" in perf-ceilings.json; run with PERF_UPDATE=1`).toBeDefined();
	expect(value, `"${name}" rose above its ceiling`).toBeLessThanOrEqual(ceiling);
	if (value < ceiling) console.log(`"${name}" is ${value}, under its ceiling of ${ceiling}: run with PERF_UPDATE=1 to lower it`);
}

test('switching rooms back and forth', async ({ page }) => {
	const { perfRoom, first, last } = await seed();
	await openChat(page);
	// A new guest has joined only General: join the Perf room from Browse rooms, which opens it.
	await page.getByTestId('browse-rooms').click();
	await page.getByTestId('room-directory').locator(`[data-join="${perfRoom}"]`).click();
	await expect(page.locator(`[data-testid="room-list"] button[data-room="${perfRoom}"]`)).toBeVisible();
	await expect(page.locator(`article[data-message-id="${last[perfRoom]}"]`)).toBeAttached();
	await page.locator('[data-testid="room-list"] button[data-room="general"]').click();
	await expect(page.locator(`article[data-message-id="${last.general}"]`)).toBeAttached();

	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	// Warm up both directions once, unthrottled.
	await switchTo(page, perfRoom, first[perfRoom], last[perfRoom]);
	await switchTo(page, 'general', first.general, last.general);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

	const times: number[] = [];
	const complete: number[] = [];
	const inserted: number[] = [];
	// PERF_PROFILE=out.cpuprofile saves a CPU profile of the measured switches.
	const profile = process.env.PERF_PROFILE;
	if (profile) {
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
		await cdp.send('Profiler.start');
	}
	const before = await metrics(cdp);
	for (let trip = 0; trip < ROUND_TRIPS; trip++) {
		for (const room of [perfRoom, 'general']) {
			const result = await switchTo(page, room, first[room], last[room]);
			times.push(result.ms);
			complete.push(result.completeMs);
			inserted.push(result.inserted);
		}
	}
	const after = await metrics(cdp);
	if (profile) writeFileSync(profile, JSON.stringify((await cdp.send('Profiler.stop')).profile));
	const switches = ROUND_TRIPS * 2;
	const per = (name: string) => (after[name] - before[name]) / switches;
	const report = {
		switches,
		'median ms (4x CPU)': Number(median(times).toFixed(1)),
		'max ms (4x CPU)': Number(Math.max(...times).toFixed(1)),
		'median ms to whole room (4x CPU)': Number(median(complete).toFixed(1)),
		'elements inserted / switch': median(inserted),
		'layouts / switch': per('LayoutCount'),
		'style recalcs / switch': per('RecalcStyleCount'),
		'script ms / switch': Number((per('ScriptDuration') * 1000).toFixed(1)),
		'layout ms / switch': Number((per('LayoutDuration') * 1000).toFixed(1)),
		'style ms / switch': Number((per('RecalcStyleDuration') * 1000).toFixed(1)),
		'DOM nodes after': after.Nodes
	};
	console.log(`room switch: ${JSON.stringify(report, null, 1)}`);
	// Each switch renders the same rows, so every switch inserts the same count.
	expect(new Set(inserted).size, `elements inserted differ between switches: ${inserted}`).toBe(1);
	ratchet('room switch: elements inserted before first paint', inserted[0]);
});
