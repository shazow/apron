<script lang="ts">
	import { safeAvatar } from '$lib/protocol/embeds';
	import { directory } from '$lib/ui/directory.svelte';
	import { avatarHue, initials } from '$lib/ui/messages';

	/**
	 * An image when the user object carries a usable avatar (§4.6.6: `https:`,
	 * small image data URLs, or files the chat server hosts), else initials on a
	 * tint whose hue comes from the `user_id`, so people are told apart at a
	 * glance. Without an ID the placeholder keeps the design system's denim.
	 */
	let { name, id, src, size = 'md' }: { name: string; id?: string; src?: string; size?: 'sm' | 'md' | 'lg' } = $props();
	let url = $derived(safeAvatar(src, directory.origin));
	let hue = $derived(id ? avatarHue(id) : undefined);
</script>

{#if url}
	<img class="ap-avatar ap-avatar-{size}" src={url} alt="" />
{:else}
	<span class="ap-avatar ap-avatar-{size}" class:hued={hue !== undefined} style:--avatar-hue={hue} aria-hidden="true">{initials(name || '?')}</span>
{/if}

<style>
	/* Muted tints at a fixed lightness per theme, so every hue reads the same and none competes with the accent. */
	.hued { background: oklch(0.33 0.06 var(--avatar-hue)); color: oklch(0.86 0.08 var(--avatar-hue)); }
	@media (prefers-color-scheme: light) {
		:global(:root:not([data-theme='dark'])) .hued { background: oklch(0.92 0.045 var(--avatar-hue)); color: oklch(0.42 0.12 var(--avatar-hue)); }
	}
	:global(:root[data-theme='light']) .hued { background: oklch(0.92 0.045 var(--avatar-hue)); color: oklch(0.42 0.12 var(--avatar-hue)); }
	:global(:root[data-theme='dark']) .hued { background: oklch(0.33 0.06 var(--avatar-hue)); color: oklch(0.86 0.08 var(--avatar-hue)); }
</style>
