/** Trusted client address handling. Raw addresses never leave this module. */

export type CanonicalIp =
	| { kind: "ipv4"; key: string; address: string }
	| { kind: "ipv6"; key: string; address: string };

function parseIpv4(value: string): number[] | null {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => {
		if (!/^\d{1,3}$/.test(part)) return -1;
		const number = Number(part);
		return number <= 255 ? number : -1;
	});
	return octets.some((part) => part < 0) ? null : octets;
}

function ipv4String(octets: number[]): string {
	return octets.join(".");
}

function ipv4MappedFromWords(words: number[]): number[] | null {
	if (words.length !== 8 || words[0] !== 0 || words[1] !== 0 || words[2] !== 0 || words[3] !== 0 || words[4] !== 0 || words[5] !== 0xffff) return null;
	return [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff];
}

/** Parse an RFC 5952 IPv6 address into eight 16-bit words. */
function parseIpv6(value: string): number[] | null {
	if (!value || value.includes("%")) return null;
	// A dotted tail is legal IPv6 syntax. Convert it into two hexadecimal words.
	let source = value;
	const lastColon = source.lastIndexOf(":");
	if (source.includes(".") && lastColon >= 0) {
		const octets = parseIpv4(source.slice(lastColon + 1));
		if (!octets) return null;
		source = `${source.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = source.split("::");
	if (halves.length > 2) return null;
	const parseHalf = (half: string): number[] | null => {
		if (half === "") return [];
		const pieces = half.split(":");
		const result: number[] = [];
		for (const piece of pieces) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
			result.push(Number.parseInt(piece, 16));
		}
		return result;
	};
	const left = parseHalf(halves[0]);
	if (!left) return null;
	const right = halves.length === 2 ? parseHalf(halves[1]) : [];
	if (!right) return null;
	if (halves.length === 1) return left.length === 8 ? left : null;
	const gap = 8 - left.length - right.length;
	if (gap < 1) return null;
	return [...left, ...new Array(gap).fill(0), ...right];
}

function wordsToIpv6(words: number[]): string {
	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < 8;) {
		if (words[index] !== 0) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < 8 && words[index] === 0) index += 1;
		if (index - start > bestLength) {
			bestStart = start;
			bestLength = index - start;
		}
	}
	if (bestLength < 2) bestStart = -1;
	const parts: string[] = [];
	for (let index = 0; index < 8;) {
		if (index === bestStart) {
			// The empty component on both sides is what gives a leading or
			// trailing compressed run its required second colon.
			parts.push("");
			index += bestLength;
			if (index === 8) parts.push("");
			continue;
		}
		parts.push(words[index].toString(16));
		index += 1;
	}
	const result = parts.join(":");
	if (result === "") return "::";
	if (result.startsWith(":") && !result.startsWith("::")) return `:${result}`;
	if (result.endsWith(":") && !result.endsWith("::")) return `${result}:`;
	return result;
}

export function canonicalizeIp(value: string): CanonicalIp | null {
	const trimmed = value.trim();
	const ipv4 = parseIpv4(trimmed);
	if (ipv4) {
		const address = ipv4String(ipv4);
		return { kind: "ipv4", key: `v4:${address}`, address };
	}
	const words = parseIpv6(trimmed);
	if (!words) return null;
	const mapped = ipv4MappedFromWords(words);
	if (mapped) {
		const address = ipv4String(mapped);
		return { kind: "ipv4", key: `v4:${address}`, address };
	}
	// A /64 key deliberately discards the interface identifier. Keep the full
	// canonical address only for internal tests; it is never logged or persisted.
	const prefix = wordsToIpv6(words.slice(0, 4).concat([0, 0, 0, 0]));
	return { kind: "ipv6", key: `v6:${prefix}/64`, address: wordsToIpv6(words) };
}

function isPseudoIpv4(value: string): boolean {
	const parsed = parseIpv4(value);
	return parsed !== null && parsed[0] >= 240;
}

/** Cloudflare's canonical client address headers, with Pseudo IPv4 handling. */
export function extractClientIp(headers: Headers): CanonicalIp | null {
	// Subrequest attribution is not equivalent to a direct visitor address.
	if (headers.has("CF-Worker")) return null;
	const connectingIpv6 = headers.get("CF-Connecting-IPv6");
	const connectingIp = headers.get("CF-Connecting-IP");
	const parsedV4Header = connectingIp ? canonicalizeIp(connectingIp) : null;
	const pseudoV4 = !!connectingIp && isPseudoIpv4(connectingIp);
	if (parsedV4Header && !pseudoV4) {
		if (parsedV4Header.address.toLowerCase() === "2a06:98c0:3600::103") return null;
		return parsedV4Header;
	}
	if (connectingIpv6) {
		const parsed = canonicalizeIp(connectingIpv6);
		// Only Pseudo IPv4 establishes this header as the original address.
		if (parsed?.kind === "ipv6" && pseudoV4) {
			if (parsed.address.toLowerCase() === "2a06:98c0:3600::103") return null;
			return parsed;
		}
	}
	return null;
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Compact, deterministic rate-limit key. This unkeyed hash is not anonymization. */
export async function hashIpKey(canonical: CanonicalIp): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical.key));
	return bytesToBase64Url(digest.slice(0, 16));
}

/** Remove all client-supplied forwarding metadata before the DO sees it. */
export function stripForwardingHeaders(headers: Headers): Headers {
	const clean = new Headers(headers);
	for (const name of [
		"cf-connecting-ip",
		"cf-connecting-ipv6",
		"cf-worker",
		"x-apron-trusted-ip-key",
		"x-apron-client-ip-key",
		"x-forwarded-for",
		"x-forwarded-host",
		"x-forwarded-proto",
		"x-real-ip",
	]) clean.delete(name);
	return clean;
}
