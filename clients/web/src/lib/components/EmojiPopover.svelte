<script lang="ts">
	import { untrack } from 'svelte';
	import { currentTheme, NARROW_MAX, pickerColors, placePicker } from '$lib/ui/emoji';
	import { emojiPicker, loadEmojiMart } from '$lib/ui/emoji-picker.svelte';

	/**
	 * The one full emoji picker (emoji-mart), drawn for whichever trigger opened
	 * it. It lives outside the app shell and is fixed to the viewport, so the
	 * timeline's overflow and containment never clip it: a popover beside the
	 * trigger on wide screens, a bottom sheet on narrow ones. emoji-mart and its
	 * data load the first time it opens, from this app's origin: it gets its
	 * data, strings and native glyphs passed in, so it fetches nothing.
	 */

	type PickerElement = HTMLElement & { update: (props: Record<string, unknown>) => void };

	let box = $state<HTMLDivElement | undefined>();
	let mount = $state<HTMLDivElement | undefined>();
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	/** Bumped on scroll and resize, so the popover follows its trigger. */
	let reflowed = $state(0);

	let request = $derived(emojiPicker.current);
	let placement = $derived.by(() => {
		void reflowed;
		return request ? placePicker(request.anchor.getBoundingClientRect(), { width: innerWidth, height: innerHeight }) : undefined;
	});

	function theme(): 'light' | 'dark' {
		return currentTheme(document.documentElement.dataset.theme, matchMedia('(prefers-color-scheme: light)').matches);
	}

	/** emoji-mart's `--rgb-*` colors from the app's tokens, for the current theme. */
	function paint(picker: HTMLElement): void {
		const style = getComputedStyle(document.documentElement);
		for (const [property, value] of Object.entries(pickerColors((token) => style.getPropertyValue(token)))) picker.style.setProperty(property, value);
	}

	// Builds the picker for each request, once emoji-mart has loaded.
	$effect(() => {
		const current = request;
		const target = mount;
		if (!current || !target) return;
		const sheet = untrack(() => placement?.mode === 'sheet');
		let cancelled = false;
		let picker: PickerElement | undefined;
		status = 'loading';
		// Focus moves in at once, so Escape works while it loads; emoji-mart then focuses its search.
		untrack(() => box)?.focus({ preventScroll: true });
		loadEmojiMart().then(
			({ Picker, data, i18n }) => {
				if (cancelled) return;
				picker = new Picker({
					data,
					i18n,
					locale: 'en',
					// System glyphs: no spritesheet or image, and the URL hooks answer nothing should one be asked for.
					set: 'native',
					getImageURL: () => '',
					getSpritesheetURL: () => '',
					theme: theme(),
					previewPosition: 'none',
					skinTonePosition: 'search',
					searchPosition: 'sticky',
					navPosition: 'top',
					perLine: 9,
					maxFrequentRows: 2,
					dynamicWidth: sheet,
					// A touch keyboard would cover the sheet; there, search is a tap away.
					autoFocus: !matchMedia('(pointer: coarse)').matches,
					onEmojiSelect: (emoji: { native?: string }) => {
						if (emoji.native) emojiPicker.pick(emoji.native);
					}
				}) as unknown as PickerElement;
				paint(picker);
				target.replaceChildren(picker);
				status = 'ready';
			},
			() => {
				if (!cancelled) status = 'failed';
			}
		);
		return () => {
			cancelled = true;
			picker?.remove();
		};
	});

	// While open: follow the trigger, close on a press outside, and follow the system theme.
	$effect(() => {
		const current = request;
		if (!current) return;
		const outside = (event: PointerEvent) => {
			const path = event.composedPath();
			if ((box && path.includes(box)) || path.includes(current.anchor)) return;
			emojiPicker.close();
		};
		const reflow = () => {
			// The trigger left the page, or the layout switched between popover and sheet: start over.
			if (!current.anchor.isConnected || (innerWidth < NARROW_MAX) !== (placement?.mode === 'sheet')) {
				emojiPicker.close();
				return;
			}
			reflowed++;
		};
		const scheme = matchMedia('(prefers-color-scheme: light)');
		const repaint = () => {
			const picker = mount?.firstElementChild as PickerElement | null | undefined;
			if (!picker?.update) return;
			picker.update({ theme: theme() });
			paint(picker);
		};
		document.addEventListener('pointerdown', outside, true);
		addEventListener('resize', reflow);
		addEventListener('scroll', reflow, true);
		scheme.addEventListener('change', repaint);
		return () => {
			document.removeEventListener('pointerdown', outside, true);
			removeEventListener('resize', reflow);
			removeEventListener('scroll', reflow, true);
			scheme.removeEventListener('change', repaint);
		};
	});

	/**
	 * Escape closes the picker, back on its trigger. It listens on the way in:
	 * emoji-mart's search field swallows its keys. Escape in the skin tone
	 * menu is left to close just that menu.
	 */
	function keydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (event.composedPath().some((node) => node instanceof Element && node.classList.contains('menu'))) return;
		event.preventDefault();
		event.stopPropagation();
		emojiPicker.close(true);
	}

	/** Tabbing out of the picker closes it, as a press outside does. */
	function focusout(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (!(next instanceof Node) || !box || box.contains(next) || request?.anchor.contains(next)) return;
		emojiPicker.close();
	}
</script>

{#if request && placement}
	<div
		class="emoji-pop"
		class:sheet={placement.mode === 'sheet'}
		role="dialog"
		aria-label="Emoji picker"
		tabindex="-1"
		data-testid="emoji-picker"
		data-state={status}
		style:top={placement.mode === 'popover' ? `${placement.top}px` : undefined}
		style:left={placement.mode === 'popover' ? `${placement.left}px` : undefined}
		style:width={placement.mode === 'popover' ? `${placement.width}px` : undefined}
		style:height={`${placement.height}px`}
		bind:this={box}
		onkeydowncapture={keydown}
		onfocusout={focusout}
	>
		{#if status !== 'ready'}
			<p class="status" role="status">{status === 'failed' ? 'Emoji couldn’t load. Close and try again.' : 'Loading emoji…'}</p>
		{/if}
		<div class="mount" bind:this={mount}></div>
	</div>
{/if}

<style>
	/* A popover: raised ground, hairline, popover shadow, large radius. */
	.emoji-pop {
		position: fixed; z-index: 40; box-sizing: border-box; display: flex; overflow: hidden;
		background: var(--bg-200); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-popover);
		font-family: var(--font-sans); color: var(--ink);
	}
	.emoji-pop:focus { outline: none; }
	/* Narrow screens: a bottom sheet, full width, rounded only where it meets the page. */
	.sheet { left: 0; right: 0; bottom: 0; border-bottom: 0; border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding-bottom: env(safe-area-inset-bottom); }
	.mount { display: flex; flex: 1; min-width: 0; min-height: 0; }
	/* emoji-mart's own custom properties, set from outside its shadow root: app type, radius and neutrals. */
	.mount :global(em-emoji-picker) {
		flex: 1; width: 100%; height: 100%; min-height: 0;
		--border-radius: calc(var(--radius-lg) - 1px);
		--shadow: none;
		--font-family: var(--font-sans);
		--font-size: 15px;
		--category-icon-size: 18px;
		--color-border: var(--bg-300);
		--color-border-over: var(--line-strong);
	}
	.status { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: var(--space-4); color: var(--ink-muted); font-size: 13px; line-height: 18px; text-align: center; }
</style>
