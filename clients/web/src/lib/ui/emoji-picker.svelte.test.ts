import { describe, expect, it, vi } from 'vitest';
import { emojiAnchor, emojiPicker } from './emoji-picker.svelte';

/** A stand-in trigger button: the controller only focuses it and checks it is still on the page. */
function trigger(connected = true) {
	return { isConnected: connected, focus: vi.fn() } as unknown as HTMLElement & { focus: ReturnType<typeof vi.fn> };
}

describe('the emoji picker controller', () => {
	it('opens for one trigger at a time, and a second press closes it', () => {
		const composer = trigger();
		const reaction = trigger();
		emojiPicker.toggle({ anchor: composer, onpick: () => {} });
		expect(emojiPicker.isOpenFor(composer)).toBe(true);
		emojiPicker.toggle({ anchor: reaction, onpick: () => {} });
		expect(emojiPicker.isOpenFor(composer)).toBe(false);
		expect(emojiPicker.isOpenFor(reaction)).toBe(true);
		emojiPicker.toggle({ anchor: reaction, onpick: () => {} });
		expect(emojiPicker.current).toBeUndefined();
		expect(emojiPicker.isOpenFor(undefined)).toBe(false);
	});

	it('hands a pick to whoever opened it, closed first', () => {
		const anchor = trigger();
		const picks: string[] = [];
		emojiPicker.toggle({ anchor, onpick: (emoji) => picks.push(`${emoji}:${emojiPicker.current === undefined}`) });
		emojiPicker.pick('🎉');
		expect(picks).toEqual(['🎉:true']);
		emojiPicker.pick('👍');
		expect(picks).toEqual(['🎉:true']);
	});

	it('returns focus to the trigger only on request (Escape), and only while it is on the page', () => {
		const anchor = trigger();
		emojiPicker.toggle({ anchor, onpick: () => {} });
		emojiPicker.close();
		expect(anchor.focus).not.toHaveBeenCalled();
		emojiPicker.toggle({ anchor, onpick: () => {} });
		emojiPicker.close(true);
		expect(anchor.focus).toHaveBeenCalledTimes(1);
		const gone = trigger(false);
		emojiPicker.toggle({ anchor: gone, onpick: () => {} });
		emojiPicker.close(true);
		expect(gone.focus).not.toHaveBeenCalled();
	});

	it('closes with the trigger that opened it, and leaves another trigger’s picker alone', () => {
		const mine = trigger();
		const other = trigger();
		emojiPicker.toggle({ anchor: other, onpick: () => {} });
		emojiAnchor(mine).destroy();
		expect(emojiPicker.isOpenFor(other)).toBe(true);
		emojiAnchor(other).destroy();
		expect(emojiPicker.current).toBeUndefined();
	});
});
