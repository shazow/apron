/**
 * The full emoji picker: one at a time, for whichever trigger opened it last.
 * `EmojiPopover` (mounted once, outside the timeline so nothing clips it)
 * draws the open request; triggers open, toggle and release it here.
 */
import type { EmojiMartData } from '@emoji-mart/data';

export interface EmojiPickerRequest {
	/** The button that opened the picker: the popover sits beside it, and Escape returns focus to it. */
	anchor: HTMLElement;
	/** A picked emoji, as its native text. The picker has closed by then. */
	onpick: (emoji: string) => void;
}

class EmojiPicker {
	/** The open picker's request, if one is open. */
	current = $state.raw<EmojiPickerRequest | undefined>();

	isOpenFor(anchor: HTMLElement | undefined): boolean {
		return anchor !== undefined && this.current?.anchor === anchor;
	}

	/** Opens the picker for this trigger, closing any other; a second press closes it. */
	toggle(request: EmojiPickerRequest): void {
		this.current = this.isOpenFor(request.anchor) ? undefined : request;
	}

	/** Closes the picker; `restoreFocus` (Escape) puts focus back on the button that opened it. */
	close(restoreFocus = false): void {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		if (restoreFocus && current.anchor.isConnected) current.anchor.focus({ preventScroll: true });
	}

	/** Closes the picker only if this trigger opened it: its owner is going away. */
	release(anchor: HTMLElement | undefined): void {
		if (this.isOpenFor(anchor)) this.current = undefined;
	}

	/** Hands a picked emoji to whoever opened the picker, closing it first. */
	pick(emoji: string): void {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		current.onpick(emoji);
	}
}

export const emojiPicker = new EmojiPicker();

/** A trigger's action: when its button leaves the page, a picker it opened closes with it. */
export function emojiAnchor(node: HTMLElement): { destroy: () => void } {
	return { destroy: () => emojiPicker.release(node) };
}

export interface EmojiMart {
	Picker: typeof import('emoji-mart').Picker;
	data: EmojiMartData;
	/** English strings, passed in so the picker never fetches a locale. */
	i18n: Record<string, unknown>;
}

let loading: Promise<EmojiMart> | undefined;

/**
 * emoji-mart and its bundled data, fetched from this app's own origin the
 * first time a picker opens: neither is in the main bundle. A failed load
 * is forgotten so the next open tries again.
 */
export function loadEmojiMart(): Promise<EmojiMart> {
	if (!loading) {
		// The data package is its JSON (sets/15/native.json); its typings only describe the shape.
		const data = import('@emoji-mart/data') as Promise<unknown> as Promise<{ default: EmojiMartData }>;
		const attempt = Promise.all([import('emoji-mart'), data, import('@emoji-mart/data/i18n/en.json')]).then(([mart, json, en]) => ({
			Picker: mart.Picker,
			data: json.default,
			// Apron's voice: no exclamation marks in UI copy.
			i18n: { ...en.default, search_no_results_1: 'No emoji found', search_no_results_2: 'Try another word' }
		}));
		loading = attempt;
		attempt.catch(() => {
			if (loading === attempt) loading = undefined;
		});
	}
	return loading;
}
