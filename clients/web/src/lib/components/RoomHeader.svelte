<script lang="ts">
	import type { RoomSnapshot } from '$lib/protocol/client';

	interface Props {
		/** The top-level room. */
		room: RoomSnapshot;
		/** The room whose history the header reports on: the open thread, else the room. */
		pane: RoomSnapshot;
		/** The open thread's title; undefined in the room view. */
		threadTitle?: string;
		/** Names typing in this room, other than the viewer. */
		typing: string[];
		/** Replies in the open thread, once its history has loaded. */
		replyCount?: number;
		/** Older replies are not loaded yet, so `replyCount` is a lower bound. */
		moreReplies?: boolean;
		/** Show the thread's Edit button (cap `rooms`). */
		canEditThread: boolean;
		editorOpen: boolean;
		editDisabled: boolean;
		/** Offer Leave for the pane's room or thread (cap `rooms`). */
		canLeave: boolean;
		onback: () => void;
		onroom: () => void;
		onedit: () => void;
		onleave: () => void;
	}
	let { room, pane, threadTitle, typing, replyCount, moreReplies = false, canEditThread, editorOpen, editDisabled, canLeave, onback, onroom, onedit, onleave }: Props = $props();
</script>

<header class="ap-roomhead">
	<button class="ap-roomhead-back" type="button" aria-label="Back to rooms" onclick={onback}>‹</button>
	<div class="ap-roomhead-text">
		{#if threadTitle !== undefined}
			<h1 class="ap-roomhead-name">
				<button class="ap-roomhead-crumb" type="button" aria-label="Back to room" onclick={onroom}>{room.title}</button>
				<span class="ap-roomhead-sep" aria-hidden="true"> › </span>
				{threadTitle}
			</h1>
		{:else}
			<h1 class="ap-roomhead-name">{room.title}</h1>
		{/if}
		{#if typing.length > 0}
			<p class="ap-roomhead-sub ap-roomhead-typing typing-head">{typing.length === 1 ? `${typing[0]} is typing…` : `${typing.length} people are typing…`}</p>
		{:else if replyCount !== undefined}
			<p class="ap-roomhead-sub">{replyCount}{moreReplies ? '+' : ''} {replyCount === 1 && !moreReplies ? 'reply' : 'replies'}</p>
		{/if}
	</div>
	{#if pane.recovering || pane.loading}
		<span class="ap-roomhead-sub" role="status">Loading history…</span>
	{:else if pane.recoveryError}
		<span class="ap-roomhead-sub" role="status">History unavailable</span>
	{/if}
	{#if canEditThread || canLeave}
		<div class="ap-roomhead-actions">
			{#if canEditThread}
				<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" aria-label="Edit thread" aria-expanded={editorOpen} disabled={editDisabled} onclick={onedit}>Edit</button>
			{/if}
			{#if canLeave}
				<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" data-testid="leave-room" aria-label={threadTitle !== undefined ? 'Leave thread' : 'Leave room'} disabled={editDisabled} onclick={onleave}>Leave</button>
			{/if}
		</div>
	{/if}
</header>

<style>
	.ap-roomhead-back { display: none; }
	.ap-roomhead-name { max-width: 100%; }
	.ap-roomhead-actions { flex: none; }
	/* Typing shows in the header's subtitle only on phones; wide layouts have the row above the composer. */
	.typing-head { display: none; }
	@media (max-width: 719px) {
		.ap-roomhead-back { display: block; }
		.typing-head { display: block; }
	}
</style>
