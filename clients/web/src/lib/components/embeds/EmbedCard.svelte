<script lang="ts">
	import { safeLink, sameOriginMedia } from '$lib/protocol/embeds';
	import type { Embed } from '$lib/protocol/types';
	import { directory } from '$lib/ui/directory.svelte';

	/** A preview built only from the embed's `og` (Appendix E): site, title, description, and an image the chat server hosts. */
	let { embed }: { embed: Embed } = $props();
	let url = $derived(safeLink(embed.url));
	let og = $derived(embed.og ?? {});
	let image = $derived(sameOriginMedia(og.image?.url, directory.origin));
	let title = $derived(og.title || embed.title || url || embed.kind);
</script>

{#snippet body()}
	{#if image}<img class="ap-embed-ogimg" src={image} alt={og.image?.alt || ''} loading="lazy" />{/if}
	<span class="ap-embed-cardtext">
		{#if og.site_name}<span class="ap-embed-site">{og.site_name}</span>{/if}
		<span class="ap-embed-title">{title}</span>
		{#if og.description}<span class="ap-embed-desc">{og.description}</span>{/if}
	</span>
{/snippet}

{#if url}
	<a class="ap-embed ap-embed-ogcard" class:ap-embed-ogcard-img={image} href={url} rel="noreferrer noopener" target="_blank">{@render body()}</a>
{:else}
	<div class="ap-embed ap-embed-ogcard" class:ap-embed-ogcard-img={image}>{@render body()}</div>
{/if}
