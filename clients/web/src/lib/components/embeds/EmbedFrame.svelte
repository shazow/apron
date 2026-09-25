<script lang="ts">
	import { safeLink } from '$lib/protocol/embeds';
	import type { Embed } from '$lib/protocol/types';

	/**
	 * A backend-served live view (§4.6): sandboxed with scripts but never
	 * same-origin, no referrer, `height` clamped to iframe-max-h. It stays a
	 * paused placeholder until the viewer loads it.
	 */
	let { embed }: { embed: Embed } = $props();
	let url = $derived(safeLink(embed.url));
	let height = $derived(Math.min(typeof embed.height === 'number' && embed.height > 0 ? embed.height : 300, 480));
	let live = $state(false);
</script>

{#if url && live}
	<iframe class="ap-embed ap-embed-frame" src={url} sandbox="allow-scripts" loading="lazy" referrerpolicy="no-referrer" allow="" style:height="{height}px" title={embed.title || 'Embedded view'}></iframe>
{:else if url}
	<div class="ap-embed ap-embed-frame ap-embed-paused" style:height="{height}px">
		<span class="ap-embed-detail">{embed.title || 'Live view'}</span>
		<button class="ap-btn ap-btn-sm" type="button" onclick={() => (live = true)}>Load live view</button>
	</div>
{:else}
	<div class="ap-embed ap-embed-card ap-embed-fallback">
		<span class="ap-embed-kind">iframe</span>
		<span class="ap-embed-detail">This live view has no usable address.</span>
	</div>
{/if}
