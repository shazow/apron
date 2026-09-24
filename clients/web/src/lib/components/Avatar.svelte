<script lang="ts">
	import { safeAvatar } from '$lib/protocol/embeds';
	import { directory } from '$lib/ui/directory.svelte';
	import { initials } from '$lib/ui/messages';

	/**
	 * An image when the user object carries a usable avatar (Appendix E: `https:`,
	 * small image data URLs, or files the chat server hosts), else initials in
	 * denim on denim-soft — the same tint for everyone.
	 */
	let { name, src, size = 'md' }: { name: string; src?: string; size?: 'sm' | 'md' | 'lg' } = $props();
	let url = $derived(safeAvatar(src, directory.origin));
</script>

{#if url}
	<img class="ap-avatar ap-avatar-{size}" src={url} alt="" />
{:else}
	<span class="ap-avatar ap-avatar-{size}" aria-hidden="true">{initials(name || '?')}</span>
{/if}
