<script lang="ts">
	import { emojiAnchor, emojiPicker } from '$lib/ui/emoji-picker.svelte';
	import { REACTION_PALETTE, type ReactionChip } from '$lib/ui/reactions';

	interface Props {
		/** One chip per emoji on the message; empty for tombstones and messages nobody reacted to. */
		chips: ReactionChip[];
		/** The server takes reactions and the session can send them now. */
		enabled: boolean;
		/** The React action's palette is open under the message. */
		paletteOpen: boolean;
		/** Adds the emoji to your set, or removes it when it is already there. */
		ontoggle: (emoji: string) => void;
		onclosepalette: () => void;
	}
	let { chips, enabled, paletteOpen, ontoggle, onclosepalette }: Props = $props();
	let mine = $derived(new Set(chips.filter((chip) => chip.mine).map((chip) => chip.emoji)));
	let palette = $state<HTMLDivElement | undefined>();
	let more = $state<HTMLButtonElement | undefined>();
	let moreOpen = $derived(emojiPicker.isOpenFor(more));

	// The palette takes focus as it opens, so a keyboard user lands on the first emoji.
	$effect(() => {
		if (paletteOpen && palette) palette.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	});

	function pick(emoji: string): void {
		onclosepalette();
		ontoggle(emoji);
	}

	/** "More emoji" opens the full picker; a pick there toggles like a pick here. */
	function openMore(): void {
		if (more) emojiPicker.toggle({ anchor: more, onpick: pick });
	}

	function paletteKeydown(key: KeyboardEvent): void {
		if (key.key !== 'Escape') return;
		key.preventDefault();
		key.stopPropagation();
		onclosepalette();
	}
</script>

{#if chips.length > 0}
	<div class="reactions" role="group" aria-label="Reactions" data-testid="reactions">
		{#each chips as chip (chip.emoji)}
			<button
				class="chip"
				class:mine={chip.mine}
				type="button"
				data-testid="reaction-chip"
				data-emoji={chip.emoji}
				aria-pressed={chip.mine}
				aria-label={chip.label}
				title={chip.title}
				disabled={!enabled}
				onclick={() => ontoggle(chip.emoji)}
			><span class="emoji" aria-hidden="true">{chip.emoji}</span><span class="count" aria-hidden="true">{chip.count}</span></button>
		{/each}
	</div>
{/if}
{#if paletteOpen}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="palette" role="toolbar" tabindex="-1" aria-label="Pick a reaction" data-testid="reaction-palette" bind:this={palette} onkeydown={paletteKeydown}>
		{#each REACTION_PALETTE as emoji (emoji)}
			<button class="pick" class:mine={mine.has(emoji)} type="button" aria-label={`React with ${emoji}`} aria-pressed={mine.has(emoji)} title={emoji} disabled={!enabled} onclick={() => pick(emoji)}>{emoji}</button>
		{/each}
		<button
			class="pick more"
			type="button"
			data-testid="more-emoji"
			aria-label="More emoji"
			title="More emoji"
			aria-haspopup="dialog"
			aria-expanded={moreOpen}
			disabled={!enabled}
			bind:this={more}
			use:emojiAnchor
			onclick={openMore}
		><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M19 2v6M16 5h6" /></svg></button>
		<button class="pick close" type="button" aria-label="Close reactions" title="Close" onclick={onclosepalette}>×</button>
	</div>
{/if}

<style>
	.reactions { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); max-width: 100%; }
	.chip {
		font: inherit; display: inline-flex; align-items: center; gap: var(--space-1);
		height: 26px; padding: 0 var(--space-2); box-sizing: border-box;
		border: 1px solid var(--line); border-radius: var(--radius-full);
		background: var(--bg-200); color: var(--ink-muted);
		font-size: 13px; line-height: 16px; font-variant-numeric: tabular-nums; cursor: pointer;
		transition: background-color .12s ease, border-color .12s ease, color .12s ease;
	}
	.chip:hover:not(:disabled) { background: var(--bg-300); color: var(--ink); }
	.chip.mine { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
	.chip:disabled { cursor: default; }
	.emoji { font-size: 15px; line-height: 16px; }
	.count { font-weight: 600; }
	.palette {
		display: inline-flex; flex-wrap: wrap; gap: 2px; max-width: 100%; margin-top: var(--space-1); padding: 3px; box-sizing: border-box;
		background: var(--bg-200); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-float);
	}
	.pick {
		font: inherit; display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0;
		border: 0; border-radius: var(--radius-full); background: transparent; color: var(--ink-muted);
		font-size: 18px; line-height: 1; cursor: pointer;
		transition: background-color .12s ease;
	}
	.pick:hover:not(:disabled) { background: var(--bg-300); color: var(--ink); }
	.pick.mine { background: var(--accent-soft); }
	.pick.more[aria-expanded='true'] { background: var(--bg-300); color: var(--ink); }
	.pick:disabled { cursor: default; opacity: .6; }
	.close { font-size: 16px; }
	.chip:focus-visible, .pick:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
	.palette:focus { outline: none; }
	/* Phones: the palette and its close button fit one row at common widths. */
	@media (max-width: 719px) {
		.pick { width: 30px; height: 32px; font-size: 17px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.chip, .pick { transition: none; }
	}
</style>
