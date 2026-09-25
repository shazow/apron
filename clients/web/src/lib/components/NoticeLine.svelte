<script lang="ts">
	import type { Notice } from '$lib/protocol/client';
	import { renderMarkdown, renderPlain } from '$lib/protocol/markdown';
	import { directory } from '$lib/ui/directory.svelte';
	import { idDateTime, idIso, idTime } from '$lib/ui/time';

	/**
	 * A transient notice (PROTOCOL.md §3.5, Appendix A.1): a `message` without
	 * `message_id`, such as a `@private` command reply, or a local one such as a
	 * command's error. A quiet system line with a dashed outline, "Only you":
	 * nobody else got it, it is not stored, and it is gone on reload.
	 */
	let { notice, onopenroom }: { notice: Notice; onopenroom: (roomId: string) => void } = $props();

	let text = $derived(typeof notice.body?.text === 'string' ? notice.body.text : '');
	let markdown = $derived(notice.body?.format === 'markdown');
	let body = $derived(markdown ? renderMarkdown(text, directory.resolve) : renderPlain(text, directory.resolve));
	let who = $derived(notice.from.user_id === '@private' ? notice.from.name || 'Only you' : `${notice.from.name || notice.from.user_id} · Only you`);
	let at = $derived(String(notice.at));

	function click(event: MouseEvent): void {
		const roomLink = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-room-id]');
		if (roomLink?.dataset.roomId) onopenroom(roomLink.dataset.roomId);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
<article data-timeline-item class="ap-msg ap-msg-system ap-msg-private" data-scope="private" data-testid="notice" tabindex="-1" onclick={click}>
	<span class="ap-msg-system-who">{who}</span>
	<div class="ap-msg-system-body"><div class="ap-msg-text" class:plain={!markdown}>{@html body}</div></div>
	<time class="ap-msg-system-time" datetime={idIso(at)} title={idDateTime(at)}>{idTime(at)}</time>
</article>

<style>
	.plain { white-space: pre-wrap; }
</style>
