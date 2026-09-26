<script lang="ts" module>
	/** Who else got a system message (PROTOCOL.md Appendix A.1). */
	export type NoticeScope = 'private' | 'room' | 'server';

	/** The scope a system identity states: `@private`, `@room`, or `@server`. */
	export function noticeScope(userId: string): NoticeScope | undefined {
		return userId === '@private' ? 'private' : userId === '@room' ? 'room' : userId === '@server' ? 'server' : undefined;
	}
</script>

<script lang="ts">
	import type { Identity } from '$lib/protocol/types';
	import { copyCode } from '$lib/ui/copy-code';

	/**
	 * A scoped system message as the design system draws it: a left-aligned
	 * card titled by its sender, `Name (@user_id)` as the server names it
	 * (§3.3), dashed when it was only for you (never stored, gone on reload).
	 * Transient notices and logged `@room`/`@server` messages both render
	 * through it; code blocks in it get a Copy button.
	 */
	interface Props {
		scope: NoticeScope;
		/** The sender, as the frame carries it: servers name their system identities. */
		from: Identity;
		/** Rendered, sanitized body HTML. */
		html: string;
		plain?: boolean;
		deleted?: boolean;
		time?: { short: string; iso?: string; full: string };
		messageId?: string;
		testid?: string;
		onclick?: (event: MouseEvent) => void;
	}
	let { scope, from, html, plain = false, deleted = false, time, messageId, testid, onclick }: Props = $props();
	let title = $derived(from.name && from.name !== from.user_id ? `${from.name} (${from.user_id})` : from.user_id);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
<article data-timeline-item class="ap-notice" class:ap-notice-private={scope === 'private'} data-scope={scope} data-message-id={messageId} data-testid={testid} tabindex="-1" {onclick}>
	<div class="ap-notice-head">
		<span class="ap-notice-title">{title}</span>
		{#if time?.short}<time class="ap-notice-time" datetime={time.iso} title={time.full}>{time.short}</time>{/if}
	</div>
	<div class="ap-notice-body">
		{#if deleted}<span class="ap-msg-tomb">Message deleted</span>{:else}<div class="ap-msg-text" class:plain use:copyCode={html}>{@html html}</div>{/if}
	</div>
</article>

<style>
	.plain { white-space: pre-wrap; }
</style>
