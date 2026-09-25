<script lang="ts">
	import type { UploadState } from '$lib/protocol/client';
	import type { Embed } from '$lib/protocol/types';
	import EmbedCard from './EmbedCard.svelte';
	import EmbedFallback from './EmbedFallback.svelte';
	import EmbedFrame from './EmbedFrame.svelte';
	import EmbedHtml from './EmbedHtml.svelte';
	import EmbedStream from './EmbedStream.svelte';
	import EmbedUpload from './EmbedUpload.svelte';

	/**
	 * One entry of `body.embeds` (§4.6), rendered by its `kind`. An
	 * unknown kind renders from `og`, else as the fallback card — never an error.
	 */
	let { embed, upload }: { embed: Embed; upload?: UploadState } = $props();
</script>

{#if embed.kind === 'upload'}
	<EmbedUpload {embed} {upload} />
{:else if embed.kind === 'stream'}
	<EmbedStream {embed} />
{:else if embed.kind === 'iframe'}
	<EmbedFrame {embed} />
{:else if embed.kind === 'html'}
	<EmbedHtml {embed} />
{:else if embed.og && typeof embed.og === 'object'}
	<EmbedCard {embed} />
{:else}
	<EmbedFallback {embed} />
{/if}
