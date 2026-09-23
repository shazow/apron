<script lang="ts">
	import { safeLink } from '$lib/protocol/embeds';
	import type { Embed } from '$lib/protocol/types';

	/** An embed this client can't render: its kind, and the link or text it carries (§3.5). */
	let { embed }: { embed: Embed } = $props();
	let url = $derived(safeLink(embed.url));
</script>

<div class="ap-embed ap-embed-card ap-embed-fallback">
	<span class="ap-embed-kind">{embed.kind || 'unknown'}</span>
	{#if url}<a class="ap-embed-url" href={url} rel="noreferrer noopener" target="_blank">{url}</a>
	{:else if typeof embed.text === 'string' && embed.text}<span class="ap-embed-detail">{embed.text}</span>
	{:else}<span class="ap-embed-detail">This client can’t display this embed.</span>{/if}
</div>
