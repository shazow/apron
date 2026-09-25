/**
 * What the composer does with its text (PROTOCOL.md §4.8). With cap `command`,
 * text that starts with one `/` is a command: `/nick`, `/join`, `/leave`, and
 * `/topic` map to the requests they spell (the last three need cap `rooms`),
 * and anything else goes to the server as a `command`. `//` posts a message
 * starting with `/`. Without cap `command`, every text is a message.
 */
export type ComposerAction =
	| { kind: 'message'; text: string }
	| { kind: 'command'; text: string }
	| { kind: 'nick'; name: string }
	| { kind: 'join'; room: string }
	| { kind: 'leave'; room?: string }
	| { kind: 'topic'; title: string };

/** Composer text that is a command: one leading `/`, not `//`. */
export function isCommand(text: string): boolean {
	return text.startsWith('/') && !text.startsWith('//');
}

export function composerAction(text: string, caps: { command: boolean; rooms: boolean }): ComposerAction {
	if (!caps.command) return { kind: 'message', text };
	if (text.startsWith('//')) return { kind: 'message', text: text.slice(1) };
	if (!isCommand(text)) return { kind: 'message', text };
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
	const name = match?.[1].toLowerCase();
	const argument = match?.[2]?.trim() ?? '';
	if (name === 'nick' && argument) return { kind: 'nick', name: argument };
	if (caps.rooms) {
		// A room may be written as its ID or `#ID`.
		if (name === 'join' && argument) return { kind: 'join', room: argument.replace(/^#/, '') };
		if (name === 'leave') return argument ? { kind: 'leave', room: argument.replace(/^#/, '') } : { kind: 'leave' };
		if (name === 'topic' && argument) return { kind: 'topic', title: argument };
	}
	return { kind: 'command', text };
}
