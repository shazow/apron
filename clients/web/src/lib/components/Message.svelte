<script lang="ts">
	import type { UploadState } from '$lib/protocol/client';
	import { renderMarkdown, renderPlain } from '$lib/protocol/markdown';
	import type { MessageRecord } from '$lib/protocol/types';
	import { directory } from '$lib/ui/directory.svelte';
	import { embedsOf, isSystem, replySnippet, senderName, textOf } from '$lib/ui/messages';
	import type { ReactionChip } from '$lib/ui/reactions';
	import { eventTime, idDateTime, idIso, idTimeCompact } from '$lib/ui/time';
	import Avatar from './Avatar.svelte';
	import ReactionBar from './ReactionBar.svelte';
	import SystemNotice, { noticeScope } from './SystemNotice.svelte';
	import Embed from './embeds/Embed.svelte';

	const LONG_PRESS_MS = 500;

	/** What the viewer may do to this message: built from the server's caps and ownership, so only real actions show. */
	export interface MessageCaps {
		reply: boolean;
		edit: boolean;
		startThread: boolean;
		select: boolean;
		removeReply: boolean;
		/** Cap `reactions`: the React action and clickable chips. */
		react: boolean;
	}

	interface Props {
		event: MessageRecord;
		/** A follower in a sender's group: no avatar or header, time on hover. */
		grouped: boolean;
		/** Looks up the quoted message of a reply, in any room (`reply_to` may cross rooms). */
		resolve: (messageId: string) => MessageRecord | undefined;
		/** Reaction chips under the message; empty for tombstones. */
		reactions: ReactionChip[];
		/** Files this client is writing to the message's upload embeds, by `embed_id`. */
		uploads: Record<string, UploadState>;
		mention: boolean;
		pinged: boolean;
		highlighted: boolean;
		/** Select mode is on for the pane. */
		selecting: boolean;
		selected: boolean;
		editing: boolean;
		startingThread: boolean;
		caps: MessageCaps;
		onreply: () => void;
		onjump: (id: string) => void;
		/** A room mention was clicked (Appendix A.3). */
		onopenroom: (roomId: string) => void;
		onedit: () => void;
		onsave: (text: string) => void;
		oncanceledit: () => void;
		ondelete: () => void;
		onremovereply: () => void;
		onstartthread: () => void;
		/** Toggle your reaction with this emoji. */
		onreact: (emoji: string) => void;
		/** Enter select mode with this message picked. */
		onbeginselect: () => void;
		/** In select mode: toggle this message, or fill the range to it. */
		onselect: (range: boolean) => void;
	}
	let {
		event, grouped, resolve, reactions, uploads, mention, pinged, highlighted, selecting, selected, editing, startingThread, caps,
		onreply, onjump, onopenroom, onedit, onsave, oncanceledit, ondelete, onremovereply, onstartthread, onreact, onbeginselect, onselect
	}: Props = $props();

	let moreOpen = $state(false);
	/**
	 * The hover toolbar is built the first time a pointer or focus reaches the
	 * row: it shows only then, and building it for every row made opening a
	 * room noticeably slower.
	 */
	let engaged = $state(false);
	let paletteOpen = $state(false);
	let draft = $state('');
	let longPress: ReturnType<typeof setTimeout> | undefined;

	let name = $derived(senderName(event));
	/**
	 * Name (@user_id) (§3.3): the handle shows beside a display name that
	 * differs from it, and always when another user shows under the same name.
	 */
	let handle = $derived(directory.person(event.from)?.user_id ?? event.from.user_id);
	let showHandle = $derived(Boolean(handle) && (handle !== name || directory.sharesName(event.from)));
	/** Who else got a system message (Appendix A.1): everyone on the server, the room, or only you. */
	let scope = $derived(noticeScope(event.from.user_id));
	let time = $derived(eventTime(event));
	let fullTime = $derived(idDateTime(event.message_id));
	let isoTime = $derived(idIso(event.message_id));
	let text = $derived(textOf(event));
	let embeds = $derived(embedsOf(event));
	let system = $derived(isSystem(event));
	let body = $derived(event.body?.format === 'markdown' ? renderMarkdown(text, directory.resolve) : renderPlain(text, directory.resolve));
	let selectable = $derived(selecting && caps.select);
	let picked = $derived(selectable && selected);
	let replyId = $derived(event.reply_to?.message_id);
	let replyTarget = $derived(replyId && !event.deleted ? resolve(replyId) : undefined);
	let chips = $derived(event.deleted ? [] : reactions);
	let hasActions = $derived(!selecting && (caps.reply || caps.edit || caps.removeReply || caps.react || caps.startThread));

	// Tombstones hide their reactions, and select mode stands the palette down.
	$effect(() => {
		if (event.deleted || selecting || !caps.react) paletteOpen = false;
	});

	$effect(() => {
		if (editing) draft = text;
		else moreOpen = false;
	});

	function editKeydown(key: KeyboardEvent): void {
		if (key.key === 'Escape') {
			key.preventDefault();
			oncanceledit();
		} else if (key.key === 'Enter' && !key.shiftKey && !key.isComposing) {
			key.preventDefault();
			save();
		}
	}

	function save(): void {
		if (!draft.trim()) return;
		onsave(draft);
	}

	function act(action: () => void): void {
		moreOpen = false;
		action();
	}

	/** Shift-click enters select mode with this message picked; inside it, plain clicks toggle. */
	function click(mouse: MouseEvent): void {
		const roomLink = (mouse.target as HTMLElement | null)?.closest<HTMLElement>('[data-room-id]');
		if (roomLink?.dataset.roomId) {
			onopenroom(roomLink.dataset.roomId);
			return;
		}
		if ((mouse.target as HTMLElement | null)?.closest('a, button, input, textarea, select')) return;
		if (selecting) {
			if (caps.select) onselect(mouse.shiftKey);
			return;
		}
		if (mouse.shiftKey && caps.select) onbeginselect();
	}

	/** Keyboard: `x` on a focused message picks it, the same as a shift-click. */
	function keydown(key: KeyboardEvent): void {
		if (key.key !== 'x' || key.metaKey || key.ctrlKey || key.altKey || !caps.select) return;
		if ((key.target as HTMLElement | null)?.closest('input, textarea, select')) return;
		key.preventDefault();
		if (selecting) onselect(false);
		else onbeginselect();
	}

	/** Touch has no hover: a long press opens select mode instead. */
	function pointerdown(pointer: PointerEvent): void {
		cancelLongPress();
		if (pointer.pointerType !== 'touch' || selecting || !caps.select) return;
		longPress = setTimeout(() => {
			longPress = undefined;
			onbeginselect();
		}, LONG_PRESS_MS);
	}

	function cancelLongPress(): void {
		if (!longPress) return;
		clearTimeout(longPress);
		longPress = undefined;
	}

	$effect(() => cancelLongPress);
</script>

{#if system && !selecting && scope}
	<!-- A scoped system message (Appendix A.1): a left-aligned card titled by who got it. -->
	<SystemNotice {scope} html={body} plain={event.body?.format !== 'markdown'} deleted={event.deleted} messageId={event.message_id}
		time={time ? { short: time, iso: isoTime, full: fullTime } : undefined} onclick={click} />
{:else if system && !selecting}
	<!-- Another system identity (Appendix A.1): a quiet centered line, no avatar, actions or grouping. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
	<article data-timeline-item class="ap-msg ap-msg-system" data-message-id={event.message_id} tabindex="-1" onclick={click}>
		<span class="ap-msg-system-who">{name}</span>
		<div class="ap-msg-system-body">
			{#if event.deleted}<span class="ap-msg-tomb">Message deleted</span>{:else}<div class="ap-msg-text" class:plain={event.body?.format !== 'markdown'}>{@html body}</div>{/if}
		</div>
		{#if time}<time class="ap-msg-system-time" datetime={isoTime} title={fullTime}>{time}</time>{/if}
	</article>
{:else}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article
	data-timeline-item
	class="ap-msg"
	class:ap-msg-grouped={grouped}
	class:ap-msg-mention={mention}
	class:ap-msg-pinged={pinged}
	class:ap-msg-highlighted={highlighted}
	class:ap-msg-selectable={selectable}
	class:ap-msg-selected={picked}
	data-message-id={event.message_id}
	tabindex="-1"
	onclick={click}
	onkeydown={keydown}
	onpointerenter={() => (engaged = true)}
	onfocusin={() => (engaged = true)}
	onpointerdown={pointerdown}
	onpointerup={cancelLongPress}
	onpointermove={cancelLongPress}
	onpointercancel={cancelLongPress}
>
	{#if selectable}
		<span class="ap-msg-check" role="checkbox" aria-checked={picked} aria-label="Select message" tabindex="0" onkeydown={(key) => { if (key.key === ' ' || key.key === 'Enter') { key.preventDefault(); onselect(false); } }}>{picked ? '✓' : ''}</span>
	{/if}
	<div class="ap-msg-gutter">
		{#if grouped}
			<time class="ap-msg-hovertime" datetime={isoTime} title={fullTime}>{idTimeCompact(event.message_id)}</time>
		{:else}
			<Avatar {name} id={directory.person(event.from)?.user_id} src={directory.avatar(event.from)} />
		{/if}
	</div>
	<div class="ap-msg-main">
		{#if !grouped}
			<header class="ap-msg-head">
				<span class="ap-msg-sender">{name}</span>
				{#if showHandle}<span class="ap-msg-handle" data-testid="sender-handle">@{handle}</span>{/if}
				<span class="ap-msg-meta">{#if time}<time datetime={isoTime} title={fullTime}>{time}</time>{/if}</span>
			</header>
		{/if}
		{#if replyId && !event.deleted}
			{#if replyTarget}
				{@const targetName = senderName(replyTarget)}
				<button class="ap-reply" data-testid="reply-reference" type="button" aria-label={`Replying to ${targetName}. Jump to their message`} onclick={() => onjump(replyTarget.message_id)}>
					<span class="ap-reply-who">
						<Avatar name={targetName} id={directory.person(replyTarget.from)?.user_id} src={directory.avatar(replyTarget.from)} size="sm" />
						{targetName}
					</span>
					<span class="ap-reply-text">{#if replyTarget.deleted}<em>Message deleted</em>{:else}{replySnippet(replyTarget)}{/if}</span>
				</button>
			{:else}
				<div class="ap-reply reply-static" data-testid="reply-reference">
					<span class="ap-reply-text"><em>Message unavailable</em></span>
				</div>
			{/if}
		{/if}
		{#if event.deleted}
			<div class="ap-msg-tomb">Message deleted</div>
		{:else if editing}
			<div class="edit">
				<textarea class="ap-field edit-field" aria-label="Edit message" bind:value={draft} rows="3" onkeydown={editKeydown}></textarea>
				<div class="ap-profedit-actions">
					<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" onclick={oncanceledit}>Cancel</button>
					<button class="ap-btn ap-btn-primary ap-btn-sm" type="button" onclick={save}>Save changes</button>
				</div>
			</div>
		{:else}
			{#if text}
				<!-- An absent format is plain (§3.5); only an explicit `markdown` body is rendered as Markdown. -->
				{#if event.body?.format === 'markdown'}
					<div class="ap-msg-text markdown">{@html body}</div>
				{:else}
					<div class="ap-msg-text plain">{@html body}</div>
				{/if}
			{/if}
			{#if embeds.length > 0}
				<div class="ap-msg-embeds">
					{#each embeds as embed, index (embed.embed_id ?? index)}
						<Embed {embed} upload={embed.embed_id ? uploads[embed.embed_id] : undefined} />
					{/each}
				</div>
			{/if}
		{/if}
		{#if !event.deleted}
			<ReactionBar {chips} enabled={caps.react} {paletteOpen} ontoggle={onreact} onclosepalette={() => (paletteOpen = false)} />
		{/if}
	</div>
	{#if hasActions && engaged}
		<div class="ap-msg-actions">
			<div class="ap-actions" role="toolbar" aria-label="Message actions">
				{#if event.deleted && caps.removeReply}
					<button class="ap-actions-btn" type="button" aria-label="Remove reply reference" onclick={() => act(onremovereply)}>Remove reply</button>
				{/if}
				{#if caps.reply}
					<button class="ap-actions-btn" type="button" aria-label="Reply to message" onclick={() => act(onreply)}>Reply</button>
				{/if}
				{#if caps.react && !event.deleted}
					<button class="ap-actions-btn" type="button" data-testid="react" aria-label="React" title="React" aria-expanded={paletteOpen} onclick={() => act(() => (paletteOpen = !paletteOpen))}>React</button>
				{/if}
				{#if caps.startThread}
					<button class="ap-actions-btn" type="button" data-testid="start-thread" aria-label="Start thread" title="Start thread" disabled={startingThread} onclick={() => act(onstartthread)}>{startingThread ? 'Starting…' : 'Start thread'}</button>
				{/if}
				{#if caps.edit}
					<button class="ap-actions-btn" type="button" aria-label="Edit message" title="Edit" onclick={() => act(onedit)}>Edit</button>
					{#if moreOpen}
						{#if replyId}
							<button class="ap-actions-btn" type="button" aria-label="Remove reply reference" onclick={() => act(onremovereply)}>Remove reply</button>
						{/if}
						{#if caps.select}
							<button class="ap-actions-btn" type="button" data-testid="select-message" aria-label="Select message" title="Select" onclick={() => act(onbeginselect)}>Select</button>
						{/if}
						<button class="ap-actions-btn ap-actions-danger" type="button" aria-label="Delete message" title="Delete" onclick={() => act(ondelete)}>Delete</button>
					{:else}
						<button class="ap-actions-btn" type="button" aria-label="More actions" aria-expanded="false" title="More" onclick={() => (moreOpen = true)}>⋯</button>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</article>
{/if}

<style>
	.ap-actions { max-width: calc(100vw - 32px); flex-wrap: wrap; }
	.reply-static { cursor: default; }
	.reply-static:hover { background: var(--bg-200); }
	.plain { white-space: pre-wrap; }
	.edit { display: flex; flex-direction: column; gap: var(--space-2); }
	.edit-field { height: auto; min-height: 66px; padding: var(--space-2); resize: vertical; font-size: 15px; line-height: 22px; }
</style>
