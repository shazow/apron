<script lang="ts">
	import { safeUrl } from '$lib/protocol/markdown';
	import { initials } from '$lib/ui/messages';

	/** An image when the sender carries one, else initials in denim on denim-soft — the same tint for everyone. */
	let { name, src, size = 'md' }: { name: string; src?: string; size?: 'sm' | 'md' | 'lg' } = $props();
	let url = $derived(safeUrl(src));
</script>

{#if url}
	<img class="ap-avatar ap-avatar-{size}" src={url} alt="" />
{:else}
	<span class="ap-avatar ap-avatar-{size}" aria-hidden="true">{initials(name || '?')}</span>
{/if}
