<script lang="ts">
	import DOMPurify from 'dompurify';
	import type { Embed } from '$lib/protocol/types';
	import EmbedFallback from './EmbedFallback.svelte';

	/** Server-relayed HTML (§4.6), inserted only after the allowlist sanitizer. */
	let { embed }: { embed: Embed } = $props();
	let html = $derived(typeof embed.html === 'string' && DOMPurify.isSupported
		? DOMPurify.sanitize(embed.html, { FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['style'] })
		: undefined);
</script>

{#if html !== undefined}
	<div class="ap-embed ap-embed-html">{@html html}</div>
{:else}
	<EmbedFallback {embed} />
{/if}
