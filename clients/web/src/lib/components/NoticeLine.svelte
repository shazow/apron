<script lang="ts">
	import type { Notice } from '$lib/protocol/client';
	import { renderMarkdown, renderPlain } from '$lib/protocol/markdown';
	import { directory } from '$lib/ui/directory.svelte';
	import { idDateTime, idIso, idTime } from '$lib/ui/time';
	import SystemNotice, { noticeScope } from './SystemNotice.svelte';

	/**
	 * A transient notice (PROTOCOL.md §3.5, Appendix A.1): a `message` without
	 * `message_id`, such as a `@private` command reply, or a local one such as a
	 * command's error. Nobody else got it unless its sender says so (a
	 * server-wide notice for a room you haven't joined), it is not stored, and
	 * it is gone on reload.
	 */
	let { notice, onopenroom }: { notice: Notice; onopenroom: (roomId: string) => void } = $props();

	let text = $derived(typeof notice.body?.text === 'string' ? notice.body.text : '');
	let markdown = $derived(notice.body?.format === 'markdown');
	let body = $derived(markdown ? renderMarkdown(text, directory.resolve) : renderPlain(text, directory.resolve));
	let at = $derived(String(notice.at));

	function click(event: MouseEvent): void {
		const roomLink = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-room-id]');
		if (roomLink?.dataset.roomId) onopenroom(roomLink.dataset.roomId);
	}
</script>

<SystemNotice
	scope={noticeScope(notice.from.user_id) ?? 'private'} from={notice.from} html={body} plain={!markdown} testid="notice"
	time={{ short: idTime(at), iso: idIso(at), full: idDateTime(at) }} onclick={click}
/>
