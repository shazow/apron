import { describe, expect, it } from 'vitest';
import { composerAction, isCommand } from './commands';

const both = { command: true, rooms: true };

describe('composer commands', () => {
	it('sends text starting with one slash as a command, and // as a message with one slash stripped', () => {
		expect(isCommand('/help')).toBe(true);
		expect(isCommand('//etc/hosts')).toBe(false);
		expect(isCommand(' /help')).toBe(false);
		expect(composerAction('/kick @guest_2 spamming', both)).toEqual({ kind: 'command', text: '/kick @guest_2 spamming' });
		expect(composerAction('//etc/hosts is odd', both)).toEqual({ kind: 'message', text: '/etc/hosts is odd' });
		expect(composerAction('hello', both)).toEqual({ kind: 'message', text: 'hello' });
	});

	it('handles the slash spellings of existing requests itself', () => {
		expect(composerAction('/nick Ada L', both)).toEqual({ kind: 'nick', name: 'Ada L' });
		expect(composerAction('/join #ops', both)).toEqual({ kind: 'join', room: 'ops' });
		expect(composerAction('/leave', both)).toEqual({ kind: 'leave' });
		expect(composerAction('/leave ops', both)).toEqual({ kind: 'leave', room: 'ops' });
		expect(composerAction('/TOPIC Deploys only ', both)).toEqual({ kind: 'topic', title: 'Deploys only' });
		// Without an argument, or without cap rooms, the server gets them.
		expect(composerAction('/nick', both)).toEqual({ kind: 'command', text: '/nick' });
		expect(composerAction('/join ops', { command: true, rooms: false })).toEqual({ kind: 'command', text: '/join ops' });
	});

	it('treats every text as a message without cap command', () => {
		const none = { command: false, rooms: true };
		expect(composerAction('/help', none)).toEqual({ kind: 'message', text: '/help' });
		expect(composerAction('//x', none)).toEqual({ kind: 'message', text: '//x' });
	});
});
