<script lang="ts">
	import { readStream, sameOriginMedia } from '$lib/protocol/embeds';
	import { renderMarkdown } from '$lib/protocol/markdown';
	import type { Embed } from '$lib/protocol/types';
	import { directory } from '$lib/ui/directory.svelte';

	const RECONNECT_MS = 2000;

	/**
	 * Live text (cap `embed:stream`, Appendix K): while the embed carries `url`
	 * the text grows as `GET url` streams it, and a reconnect replaces what was
	 * shown; once a snapshot carries `text` instead, it is finished. Streams
	 * load only from the chat server's origin.
	 */
	let { embed }: { embed: Embed } = $props();
	let url = $derived(sameOriginMedia(embed.url, directory.origin));
	let format = $derived(embed.format === 'terminal' || embed.format === 'markdown' ? embed.format : 'plain');
	let streamed = $state('');
	let ended = $state(false);
	let live = $derived(Boolean(url) && !ended && embed.text === undefined);
	let text = $derived(embed.text !== undefined ? String(embed.text) : streamed);

	$effect(() => {
		const source = url;
		streamed = '';
		ended = false;
		if (!source) return;
		const controller = new AbortController();
		let retry: ReturnType<typeof setTimeout> | undefined;
		const read = (): void => {
			readStream(source, (next) => (streamed = next), controller.signal)
				.then(() => (ended = true))
				.catch(() => {
					// The stream may not have started yet, or the connection dropped: try again
					// until the snapshot finishing it arrives and removes the url.
					if (!controller.signal.aborted) retry = setTimeout(read, RECONNECT_MS);
				});
		};
		read();
		return () => {
			controller.abort();
			if (retry) clearTimeout(retry);
		};
	});
</script>

<div class="ap-embed ap-embed-stream ap-embed-stream-{format}" class:ap-embed-stream-live={live} data-testid="stream-embed">
	<div class="ap-embed-streamhead">
		<span class="ap-embed-streamkind">{embed.title || (format === 'terminal' ? 'Terminal' : format === 'markdown' ? 'Live text' : 'Output')}</span>
		{#if live}
			<span class="ap-embed-livebadge" role="status"><i aria-hidden="true"></i>Live</span>
		{:else}
			<span class="ap-embed-detail">{embed.text !== undefined ? 'Finished' : url ? 'Ended' : 'Unavailable'}</span>
		{/if}
	</div>
	{#if format === 'markdown'}
		<div class="ap-embed-streambody ap-msg-text">{@html renderMarkdown(text)}{#if live}<span class="ap-embed-caret" aria-hidden="true"></span>{/if}</div>
	{:else}
		<pre class="ap-embed-streambody" aria-live={live ? 'polite' : undefined}>{text}{#if live}<span class="ap-embed-caret" aria-hidden="true"></span>{/if}</pre>
	{/if}
</div>
