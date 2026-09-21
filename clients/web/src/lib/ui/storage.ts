import { isJsonObject, type JsonObject } from '$lib/protocol/types';

/** Everything this client remembers between visits lives under one prefix. */
const KEY = {
	serverUrl: 'apron.serverUrl',
	displayName: 'apron.displayName',
	recentServers: 'apron.recentServers',
	sidebar: 'apron.sidebar'
} as const;

export type RecentServer = { url: string; label?: string };
export type SidebarPrefs = { width: number; collapsed: boolean };

export const RECENT_SERVERS_MAX = 5;

function read(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch {
		// Private mode or a full quota: the page still works for this visit.
	}
}

export function loadServerUrl(): string | undefined {
	return read(KEY.serverUrl) ?? undefined;
}

export function saveServerUrl(url: string): void {
	write(KEY.serverUrl, url);
}

export function loadDisplayName(): string {
	return read(KEY.displayName) ?? '';
}

export function saveDisplayName(name: string): void {
	write(KEY.displayName, name);
}

export function loadRecentServers(): RecentServer[] {
	try {
		const parsed: unknown = JSON.parse(read(KEY.recentServers) ?? '[]');
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(isJsonObject)
			.filter((entry): entry is RecentServer & JsonObject => typeof entry.url === 'string')
			.map((entry) => ({ url: entry.url, ...(typeof entry.label === 'string' ? { label: entry.label } : {}) }))
			.slice(0, RECENT_SERVERS_MAX);
	} catch {
		return [];
	}
}

/** Puts a backend at the head of the recent list, dropping its older entry and the tail. */
export function rememberServer(recent: RecentServer[], url: string, label: string | undefined): RecentServer[] {
	const entry: RecentServer = { url, ...(label ? { label } : {}) };
	const next = [entry, ...recent.filter((server) => server.url !== url)].slice(0, RECENT_SERVERS_MAX);
	write(KEY.recentServers, JSON.stringify(next));
	return next;
}

export function loadSidebarPrefs(): Partial<SidebarPrefs> {
	try {
		const parsed: unknown = JSON.parse(read(KEY.sidebar) ?? '{}');
		if (!isJsonObject(parsed)) return {};
		return {
			...(typeof parsed.width === 'number' && Number.isFinite(parsed.width) && parsed.width > 0 ? { width: parsed.width } : {}),
			...(typeof parsed.collapsed === 'boolean' ? { collapsed: parsed.collapsed } : {})
		};
	} catch {
		return {};
	}
}

export function saveSidebarPrefs(prefs: SidebarPrefs): void {
	write(KEY.sidebar, JSON.stringify(prefs));
}
