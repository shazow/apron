<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { passkeySupportError } from '$lib/protocol/webauthn';
	import { ChatClient, defaultWebSocketUrl, normalizeWebSocketUrl, timelineMessages, type RoomSnapshot } from '$lib/protocol/client';
	import { renderMarkdown } from '$lib/protocol/markdown';
	import type { MessageRecord } from '$lib/protocol/types';
	import Composer from '$lib/components/Composer.svelte';
	import ConnectScreen from '$lib/components/ConnectScreen.svelte';
	import JumpBar from '$lib/components/JumpBar.svelte';
	import Message, { type MessageCaps } from '$lib/components/Message.svelte';
	import RoomHeader from '$lib/components/RoomHeader.svelte';
	import SelectionBar from '$lib/components/SelectionBar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import SidebarHandle from '$lib/components/SidebarHandle.svelte';
	import StatusBanner from '$lib/components/StatusBanner.svelte';
	import ThreadCard from '$lib/components/ThreadCard.svelte';
	import ThreadEditor from '$lib/components/ThreadEditor.svelte';
	import TypingDots from '$lib/components/TypingDots.svelte';
	import { backendHost, demoRetentionNotice, statusLabel } from '$lib/ui/connection';
	import { FeedbackState } from '$lib/ui/feedback.svelte';
	import { MentionTracker } from '$lib/ui/mentions.svelte';
	import { embedFor, isOwn, mentionsMe, peopleIn, replySnippet, senderName } from '$lib/ui/messages';
	import { MessageSelection } from '$lib/ui/selection.svelte';
	import { SessionView } from '$lib/ui/session.svelte';
	import { SidebarLayout } from '$lib/ui/sidebar.svelte';
	import { loadDisplayName, loadRecentServers, loadServerUrl, rememberServer, type RecentServer } from '$lib/ui/storage';
	import { buildTimeline, threadEntries } from '$lib/ui/timeline';

	type PendingThreadStart = { room: string; thread_id: string };

	const session = new SessionView();
	const feedback = new FeedbackState();
	const mentions = new MentionTracker();
	const selection = new MessageSelection();
	const sidebar = new SidebarLayout();

	let client = $state<ChatClient | undefined>();
	let serverInput = $state('');
	let displayName = $state('');
	let composerText = $state('');
	let connectOpen = $state(false);
	let recentServers = $state<RecentServer[]>([]);
	let passkeyUnavailable = $state<string | undefined>();
	let highlightedId = $state<string | undefined>();
	let editingId = $state<string | undefined>();
	let threadEditorOpen = $state(false);
	let activeThread = $state<string | undefined>();
	let selectedRoomId = $state<string | undefined>();
	let drafts = $state<Record<string, string>>({});
	let replyDrafts = $state<Record<string, string | undefined>>({});
	let replyId = $state<string | undefined>();
	let pendingThreadStarts = $state<Record<string, PendingThreadStart>>({});
	let mobilePane = $state<'rooms' | 'main'>('main');
	let composer = $state<Composer | undefined>();
	let messageScroll = $state<HTMLDivElement | undefined>();
	let stickToBottom = $state(true);
	let latestVisible = $state(true);
	let seenCount = $state(0);
	let typingTimer: ReturnType<typeof setTimeout> | undefined;
	let highlightTimer: ReturnType<typeof setTimeout> | undefined;

	let snapshot = $derived(session.snapshot);
	let activeRoom = $derived(session.activeRoom);
	let allMessages = $derived(timelineMessages(activeRoom));
	let messages = $derived(activeThread ? allMessages.filter((event) => event.thread_id === activeThread) : allMessages.filter((event) => !event.thread_id));
	let threads = $derived(threadEntries(activeRoom, allMessages));
	let threadsById = $derived(new Map(threads.map((entry) => [entry.thread_id, entry])));
	let threadsByRoot = $derived(new Map(threads.filter((entry) => entry.announced && entry.root_message_id).map((entry) => [entry.root_message_id!, entry])));
	let activeThreadEntry = $derived.by(() => {
		const entry = activeThread ? threadsById.get(activeThread) : undefined;
		return entry?.announced ? entry : undefined;
	});
	let timeline = $derived(buildTimeline({ messages: allMessages, threadsByRoot, thread: activeThread, threadRoot: activeThreadEntry?.root_message_id }));
	let canCompose = $derived(Boolean(activeRoom && session.ready && !snapshot.authBusy && (!activeThread || activeThreadEntry)));
	let people = $derived(peopleIn(allMessages, session.you));
	let typingNames = $derived(snapshot.typing
		.filter((entry) => entry.room === activeRoom?.id && entry.from.user_id !== session.you?.user_id)
		.map((entry) => entry.from.name || entry.from.user_id));
	let backendLabel = $derived(session.server?.name || backendHost(serverInput) || 'Apron');
	let threadReplyCount = $derived(activeThreadEntry ? messages.filter((event) => event.message_id !== activeThreadEntry?.root_message_id).length : undefined);
	let unseenCount = $derived(stickToBottom ? 0 : Math.max(0, messages.length - seenCount));
	let demoNotice = $derived(demoRetentionNotice(session.server));
	/** The pane's messages this viewer may pick, in order: what shift-click ranges run along. */
	let selectableOrder = $derived(messages.filter(canSelect).map((event) => event.message_id));
	let selectThreads = $derived(threads.filter((entry) => entry.announced && entry.thread_id !== activeThread));

	$effect(() => {
		const roomId = activeRoom?.id;
		if (roomId && selectedRoomId !== roomId) setDestination(roomId, undefined);
	});

	$effect(() => {
		mentions.observe(session.rooms, session.you, { room: activeRoom?.id, thread: activeThread }, latestVisible);
	});

	// Leaving a pane ends its selection in setDestination; losing the cap ends it here.
	$effect(() => {
		if (!session.canEdit) selection.cancel();
	});

	// A thread this viewer just started opens once the server has moved its root into it.
	$effect(() => {
		const room = activeRoom;
		if (!room) return;
		for (const [eventId, pending] of Object.entries(pendingThreadStarts)) {
			if (pending.room !== room.id) continue;
			const event = room.timeline.events[eventId];
			if (!event) continue;
			if (event.thread_id === pending.thread_id) {
				forgetThreadStart(eventId);
				setDestination(room.id, pending.thread_id);
				break;
			}
			if (event.thread_id) forgetThreadStart(eventId);
		}
	});

	$effect(() => {
		if (editingId && (!activeRoom?.timeline.events[editingId] || activeRoom.timeline.events[editingId].deleted || !messages.some((event) => event.message_id === editingId))) {
			editingId = undefined;
		}
	});

	$effect(() => {
		messages.length;
		activeRoom?.id;
		if (!stickToBottom || !messageScroll) return;
		requestAnimationFrame(() => {
			if (messageScroll && stickToBottom) messageScroll.scrollTop = messageScroll.scrollHeight;
		});
	});

	$effect(() => {
		const scroll = messageScroll;
		const items = timeline;
		if (!scroll) return;
		let observer: IntersectionObserver | undefined;
		const frame = requestAnimationFrame(() => {
			const nodes = scroll.querySelectorAll<HTMLElement>('[data-timeline-item]');
			const latest = nodes[nodes.length - 1];
			if (!items.length || !latest) {
				latestVisible = true;
				return;
			}
			observer = new IntersectionObserver(([entry]) => {
				latestVisible = entry.isIntersecting;
				if (latestVisible) {
					seenCount = messages.length;
					mentions.clearUnseen();
				}
			}, { root: scroll });
			observer.observe(latest);
		});
		return () => {
			cancelAnimationFrame(frame);
			observer?.disconnect();
		};
	});

	onMount(() => {
		passkeyUnavailable = passkeySupportError();
		sidebar.load();
		serverInput = loadServerUrl() ?? defaultWebSocketUrl(window.location);
		displayName = loadDisplayName();
		recentServers = loadRecentServers();
		const chat = new ChatClient(normalizeWebSocketUrl(serverInput, window.location), displayName);
		const unsubscribe = chat.subscribe((next) => session.apply(next, chat));
		chat.start();
		client = chat;
		return () => {
			if (typingTimer) clearTimeout(typingTimer);
			if (highlightTimer) clearTimeout(highlightTimer);
			feedback.dispose();
			mentions.dispose();
			session.dispose();
			unsubscribe();
			chat.stop();
		};
	});

	// --- Connecting ---

	function openConnect(): void {
		connectOpen = true;
	}

	/** The connect form was submitted: whatever belonged to the previous backend goes. */
	function leaveBackend(): void {
		saveCurrentDraft();
		selectedRoomId = undefined;
		activeThread = undefined;
		pendingThreadStarts = {};
		composerText = '';
		replyId = undefined;
		threadEditorOpen = false;
		selection.cancel();
		session.forget();
	}

	function connected(): void {
		if (client) recentServers = rememberServer(recentServers, client.url, session.server?.name || backendHost(client.url) || undefined);
		connectOpen = false;
	}

	// --- Navigation and drafts ---

	function chooseRoom(room: RoomSnapshot): void {
		if (!client) return;
		mentions.clearRoom(room.id);
		session.chooseRoom(client, room.id);
		setDestination(room.id, undefined);
		mobilePane = 'main';
		composer?.focus();
	}

	function draftKey(roomId: string, thread: string | undefined): string {
		return JSON.stringify([client?.url ?? serverInput, roomId, thread ?? null]);
	}

	function saveCurrentDraft(): void {
		if (!selectedRoomId) return;
		const key = draftKey(selectedRoomId, activeThread);
		drafts = { ...drafts, [key]: composerText };
		replyDrafts = { ...replyDrafts, [key]: replyId };
	}

	/** Moves the pane to a room or one of its threads, keeping each destination's draft and reply. */
	function setDestination(roomId: string, thread: string | undefined): void {
		if (selectedRoomId === roomId && activeThread === thread) return;
		saveCurrentDraft();
		selectedRoomId = roomId;
		activeThread = thread;
		const key = draftKey(roomId, thread);
		composerText = drafts[key] ?? '';
		replyId = replyDrafts[key];
		editingId = undefined;
		threadEditorOpen = false;
		selection.cancel();
		composer?.reset();
		mentions.clearUnseen();
		mentions.clearRoom(roomId);
		stickToBottom = true;
	}

	function chooseThread(thread: string): void {
		if (!activeRoom) return;
		setDestination(activeRoom.id, thread);
		stickToBottom = false;
		seenCount = messages.length;
		requestAnimationFrame(() => { if (messageScroll) messageScroll.scrollTop = 0; });
		loadThread(activeRoom.id, thread);
		mobilePane = 'main';
		composer?.focus();
	}

	function loadThread(roomId: string, thread: string): void {
		client?.loadThread(roomId, thread).catch((cause: Error) => feedback.error(cause));
	}

	function backToRoom(): void {
		if (!activeRoom) return;
		setDestination(activeRoom.id, undefined);
		composer?.focus();
	}

	function threadTitle(thread: string): string {
		return threadsById.get(thread)?.title || thread;
	}

	function forgetThreadStart(eventId: string): void {
		const next = { ...pendingThreadStarts };
		delete next[eventId];
		pendingThreadStarts = next;
	}

	// --- Composing ---

	function composerInput(): void {
		if (!client || !activeRoom) return;
		if (selectedRoomId) drafts = { ...drafts, [draftKey(selectedRoomId, activeThread)]: composerText };
		client.sendTyping(activeRoom.id, true);
		if (typingTimer) clearTimeout(typingTimer);
		typingTimer = setTimeout(() => client?.sendTyping(activeRoom?.id ?? '', false), 5000);
	}

	function sendMessage(): void {
		if (!client || !activeRoom || !canCompose || !composerText.trim()) return;
		const draft = composerText;
		const roomId = activeRoom.id;
		const thread = activeThread;
		const reply = replyId;
		const originKey = draftKey(roomId, thread);
		const handle = client.sendMessage(roomId, draft, 'markdown', thread, reply);
		feedback.track(handle, 'Sending…', () => {
			// A failed send gives the draft back, unless something else has been typed since.
			const currentKey = selectedRoomId ? draftKey(selectedRoomId, activeThread) : undefined;
			if (!drafts[originKey] && !replyDrafts[originKey] && !(currentKey === originKey && (composerText || replyId))) {
				drafts = { ...drafts, [originKey]: draft };
				replyDrafts = { ...replyDrafts, [originKey]: reply };
			}
			if (currentKey === originKey && !composerText && !replyId) {
				composerText = drafts[originKey];
				replyId = replyDrafts[originKey];
				composer?.focus();
			}
		});
		clearComposer(roomId, thread);
		client.sendTyping(roomId, false);
		if (typingTimer) clearTimeout(typingTimer);
		stickToBottom = true;
		composer?.focus();
	}

	function clearComposer(roomId: string, thread: string | undefined): void {
		const key = draftKey(roomId, thread);
		composerText = '';
		replyId = undefined;
		drafts = { ...drafts, [key]: '' };
		replyDrafts = { ...replyDrafts, [key]: undefined };
	}

	/** Uploads one file (§6.1) and sends it as an embed beside whatever is in the composer. */
	async function sendUpload(file: File): Promise<void> {
		if (!client || !activeRoom || !canCompose || !session.canUpload) return;
		const chat = client;
		const roomId = activeRoom.id;
		const thread = activeThread;
		const reply = replyId;
		const text = composerText;
		feedback.pending(`Uploading ${file.name}…`);
		let url: string;
		try {
			url = await chat.uploadMedia(file);
		} catch (cause) {
			feedback.error(cause, 'Upload failed');
			return;
		}
		clearComposer(roomId, thread);
		stickToBottom = true;
		feedback.track(chat.sendMessage(roomId, text, 'markdown', thread, reply, [embedFor(file, url)]), 'Sending…');
	}

	function beginReply(event: MessageRecord): void {
		if (!canCompose || event.deleted) return;
		replyId = event.message_id;
		saveCurrentDraft();
		composer?.focus();
	}

	function cancelReply(): void {
		replyId = undefined;
		saveCurrentDraft();
		composer?.focus();
	}

	function replyPreview(id: string): string {
		const target = activeRoom?.timeline.events[id];
		if (!target) return 'Message unavailable';
		if (target.deleted) return 'Message deleted';
		return `${senderName(target)}: ${replySnippet(target)}`;
	}

	// --- Reading ---

	/** Scrolls the timeline to a message and highlights it for a moment, opening its thread first if it lives in one. */
	async function jumpToMessage(id: string): Promise<void> {
		const room = activeRoom;
		const target = room?.timeline.events[id];
		if (!room || !target) return;
		if (target.thread_id !== activeThread) {
			setDestination(room.id, target.thread_id);
			stickToBottom = false;
			if (target.thread_id) loadThread(room.id, target.thread_id);
			await tick();
		}
		const node = messageScroll?.querySelector<HTMLElement>(`article[data-message-id="${CSS.escape(id)}"]`);
		if (!node) return;
		stickToBottom = false;
		node.scrollIntoView({ block: 'center' });
		node.focus({ preventScroll: true });
		highlightedId = id;
		if (highlightTimer) clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => (highlightedId = undefined), 1600);
	}

	function jumpToLatest(): void {
		stickToBottom = true;
		mentions.clearUnseen();
		if (messageScroll) messageScroll.scrollTop = messageScroll.scrollHeight;
	}

	/** Takes you to the oldest mention that arrived while you were reading back. */
	function jumpToMention(): void {
		const target = mentions.takeUnseen();
		if (target) void jumpToMessage(target);
		else jumpToLatest();
	}

	function trackScroll(): void {
		if (!messageScroll) return;
		const atBottom = messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight < 96;
		if (!atBottom && stickToBottom) seenCount = messages.length;
		stickToBottom = atBottom;
	}

	// --- Editing ---

	function canSelect(event: MessageRecord): boolean {
		return session.canEdit && isOwn(event, session.you) && !event.deleted;
	}

	/** What the toolbar offers: only what the server can do, and only on messages this viewer may change. */
	function capsFor(event: MessageRecord): MessageCaps {
		const own = session.canEdit && isOwn(event, session.you);
		return {
			reply: canCompose && !event.deleted,
			edit: own && !event.deleted,
			startThread: own && !event.deleted && !event.thread_id && !activeThread,
			select: own && !event.deleted,
			removeReply: own && Boolean(event.reply_message_id)
		};
	}

	function saveEdit(event: MessageRecord, text: string): void {
		if (!client || !activeRoom || !session.canEdit) return;
		feedback.track(client.updateMessage(activeRoom.id, event.message_id, text), 'Saving edit…');
		editingId = undefined;
	}

	function deleteMessage(event: MessageRecord): void {
		if (!client || !activeRoom || !session.canEdit) return;
		if (!confirm('Delete this message? This cannot be undone.')) return;
		feedback.track(client.deleteMessage(activeRoom.id, event.message_id), 'Deleting message…');
	}

	function removeReply(event: MessageRecord): void {
		if (!client || !activeRoom || !session.canEdit) return;
		feedback.track(client.setMessageReply(activeRoom.id, event.message_id, null), 'Removing reply reference…');
	}

	/** Proposes a thread rooted at this message: the server assigns the ID, then the message is saved into it. */
	async function startThread(event: MessageRecord): Promise<void> {
		if (!client || !activeRoom || !canSelect(event) || event.thread_id) return;
		const chat = client;
		const roomId = activeRoom.id;
		pendingThreadStarts = { ...pendingThreadStarts, [event.message_id]: { room: roomId, thread_id: '' } };
		feedback.pending('Starting thread…');
		try {
			const result = await chat.createThread(roomId, { root_message_id: event.message_id }).promise;
			if (typeof result.thread_id !== 'string') throw new Error('Invalid thread response');
			pendingThreadStarts = { ...pendingThreadStarts, [event.message_id]: { room: roomId, thread_id: result.thread_id } };
			await chat.setMessageThread(roomId, event.message_id, result.thread_id).promise;
			feedback.clear();
		} catch (cause) {
			forgetThreadStart(event.message_id);
			feedback.error(cause, 'Unable to start thread');
		}
	}

	// --- Select mode ---

	function beginSelect(event: MessageRecord): void {
		if (!activeRoom || !canSelect(event)) return;
		editingId = undefined;
		composer?.reset();
		selection.begin(activeRoom.id, activeThread, event.message_id);
	}

	/** Moves the selection; a new thread is opened once it exists, an existing destination leaves the pane as it is. */
	async function moveSelection(thread: string | null | 'new'): Promise<void> {
		if (!client || !activeRoom || !session.canEdit) return;
		const roomId = activeRoom.id;
		const result = thread === 'new'
			? await selection.moveToNewThread(client, messages.map((event) => event.message_id))
			: await selection.move(client, thread);
		if (!result.moved) {
			if (result.error !== undefined) feedback.error(result.error, 'Some messages could not be moved');
			return;
		}
		if (thread === 'new' && result.thread) {
			setDestination(roomId, result.thread);
			loadThread(roomId, result.thread);
		}
	}

	/** Escape leaves select mode, as it leaves the thread menu. */
	function windowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !selection.active) return;
		if (selection.menuOpen) {
			selection.menuOpen = false;
			return;
		}
		selection.cancel();
		composer?.focus();
	}
</script>

<svelte:window onkeydown={windowKeydown} />

<svelte:head>
	<title>Apron</title>
	<meta name="description" content="Apron, a chat frontend for the Bottomless Chat protocol." />
</svelte:head>

{#if !client}
	<div class="app ap-shell ap-shell-norail"></div>
{:else if connectOpen}
	<ConnectScreen
		{client} {session} bind:serverInput bind:displayName {passkeyUnavailable} {recentServers}
		canCancel={session.rooms.length > 0 || session.ready}
		onconnect={leaveBackend} onconnected={connected} oncancel={() => (connectOpen = false)}
	/>
{:else}
<div
	class="app ap-shell ap-shell-norail"
	class:side-collapsed={sidebar.collapsed}
	class:side-resizing={sidebar.resizing}
	data-pane={mobilePane}
	style:--sidebar-w="{sidebar.collapsed ? 0 : sidebar.width}px"
>
	<Sidebar
		{client} {session} {backendLabel} {threads} {activeThread} mentions={mentions.byRoom} bind:displayName {passkeyUnavailable}
		onconnect={openConnect} onroom={chooseRoom} onthread={chooseThread} onsignout={() => session.forget()}
	/>
	<SidebarHandle layout={sidebar} />

	<main class="ap-shell-main" aria-label="Conversation">
		{#if activeRoom}
			<RoomHeader
				room={activeRoom}
				threadTitle={activeThread ? threadTitle(activeThread) : undefined}
				typing={typingNames}
				replyCount={activeThread && activeThreadEntry ? threadReplyCount : undefined}
				canEditThread={Boolean(activeThread && session.canEdit && activeThreadEntry)}
				editorOpen={threadEditorOpen}
				editDisabled={!canCompose}
				onback={() => (mobilePane = 'rooms')} onroom={backToRoom} onedit={() => (threadEditorOpen = !threadEditorOpen)}
			/>
			{#if threadEditorOpen && activeThreadEntry}
				{#key activeThreadEntry.thread_id}
					<ThreadEditor {client} thread={activeThreadEntry} enabled={canCompose && session.canEdit} onclose={() => (threadEditorOpen = false)} />
				{/key}
			{/if}

			{#if session.connection === 'reconnecting' && !session.reconnectNeedsAttention}
				<!-- A short blip stays quiet: the room, history, and identity are all kept in place while the socket comes back. -->
				<div class="reconnect-quiet" role="status">
					<TypingDots />
					<span data-testid="connection-status" aria-live="polite">{statusLabel(snapshot, session.stalled)}</span>
				</div>
			{:else if session.connection !== 'connected'}
				<div class="banner">
					<StatusBanner tone={session.connection === 'connecting' ? 'warn' : 'danger'} testid="connection-status" live>
						{statusLabel(snapshot, session.stalled)}
						{#snippet action()}
							{#if session.reconnectNeedsAttention}
								<button class="ap-btn ap-btn-sm" type="button" data-testid="reconnect-retry" disabled={Boolean(snapshot.retryAfterMs)} onclick={() => client && session.retryNow(client)}>Try Again</button>
							{/if}
						{/snippet}
					</StatusBanner>
				</div>
			{:else}
				<span class="sr" data-testid="connection-status" role="status" aria-live="polite">Connected</span>
			{/if}
			{#if demoNotice}
				<div class="banner demo-notice">
					<StatusBanner tone="warn" role="note">{demoNotice}</StatusBanner>
				</div>
			{/if}
			{#if activeThread && !activeThreadEntry}
				<div class="banner">
					<StatusBanner tone="danger">
						This thread is no longer available on the server.
						{#snippet action()}<button class="ap-btn ap-btn-sm" type="button" onclick={backToRoom}>Back to room</button>{/snippet}
					</StatusBanner>
				</div>
			{/if}

			<div class="ap-timeline" bind:this={messageScroll} onscroll={trackScroll} data-testid="message-list" role="log" aria-live="polite" aria-label={`${activeThread ? threadTitle(activeThread) : activeRoom.name} messages`}>
				{#if activeThreadEntry?.summary?.trim()}
					<section class="ap-summary" aria-label="Thread summary">
						<span class="ap-summary-label">Summary</span>
						<div class="ap-summary-text ap-msg-text markdown" data-testid="thread-summary">{@html renderMarkdown(activeThreadEntry.summary, people)}</div>
					</section>
				{/if}
				{#if snapshot.showReconnectDivider}
					<div class="ap-divider ap-divider-gap" role="separator" data-testid="reconnect-divider"><span>Reconnected · earlier messages aren’t available</span></div>
				{/if}
				{#if timeline.length === 0 && !activeRoom.recovering}
					<div class="empty">
						<h2>{activeThread ? 'No replies yet' : 'Nothing here yet'}</h2>
						<p>{activeThread ? 'Reply below to continue the thread.' : `Start the conversation in ${activeRoom.name}.`}</p>
					</div>
				{:else}
					{#each timeline as item (item.key)}
						{#if item.kind === 'date'}
							<div class="ap-divider ap-divider-date ap-divider-sticky" role="separator"><span>{item.label}</span></div>
						{:else if item.kind === 'replies'}
							<div class="ap-divider ap-divider-date" role="separator"><span>{item.count} {item.count === 1 ? 'reply' : 'replies'}</span></div>
						{:else if item.kind === 'thread'}
							<ThreadCard entry={item.entry} onopen={() => chooseThread(item.entry.thread_id)} />
						{:else}
							{@const event = item.event}
							<Message
								{event}
								grouped={item.grouped}
								room={activeRoom}
								{people}
								mention={mentionsMe(event, session.you)}
								pinged={mentions.pinged.includes(event.message_id)}
								highlighted={highlightedId === event.message_id}
								selecting={selection.active}
								selected={selection.has(event.message_id)}
								editing={editingId === event.message_id}
								startingThread={Boolean(pendingThreadStarts[event.message_id])}
								caps={capsFor(event)}
								onreply={() => beginReply(event)}
								onjump={jumpToMessage}
								onedit={() => (editingId = event.message_id)}
								onsave={(text) => saveEdit(event, text)}
								oncanceledit={() => (editingId = undefined)}
								ondelete={() => deleteMessage(event)}
								onremovereply={() => removeReply(event)}
								onstartthread={() => startThread(event)}
								onbeginselect={() => beginSelect(event)}
								onselect={(range) => selection.toggle(event.message_id, selectableOrder, range)}
							/>
						{/if}
					{/each}
				{/if}
			</div>

			{#if timeline.length > 0 && !latestVisible}
				<JumpBar count={unseenCount} mentions={mentions.unseen.length} onjump={jumpToLatest} onjumpmention={jumpToMention} />
			{/if}

			<div class="ap-typing typing-row" aria-live="polite">
				{#if typingNames.length > 0}
					<TypingDots />
					{typingNames.length === 1 ? `${typingNames[0]} is typing` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing` : 'Several people are typing'}…
				{/if}
			</div>

			{#if selection.active}
				<SelectionBar
					{selection} threads={selectThreads} inThread={Boolean(activeThread)}
					onmove={moveSelection} onnewthread={() => moveSelection('new')} onfill={() => selection.fillBetween(selectableOrder)}
					oncancel={() => { selection.cancel(); composer?.focus(); }}
				/>
			{:else}
				<Composer
					bind:this={composer}
					bind:value={composerText}
					placeholder={activeThread ? `Reply in ${threadTitle(activeThread)}` : `Message ${activeRoom.name}`}
					disabled={!canCompose}
					canUpload={session.canUpload}
					{people}
					replyPreview={replyId ? replyPreview(replyId) : undefined}
					oninput={composerInput} onsend={sendMessage} onupload={sendUpload} oncancelreply={cancelReply}
				/>
			{/if}
		{:else}
			<div class="empty empty-room">
				{#if session.connection !== 'connected'}
					<StatusBanner tone={session.connection === 'offline' ? 'danger' : 'warn'} testid="connection-status" live>{statusLabel(snapshot, session.stalled)}</StatusBanner>
				{:else}
					<span class="sr" data-testid="connection-status" role="status" aria-live="polite">Connected</span>
					<h2>No room open</h2>
					<p>Pick a room from the list.</p>
				{/if}
				<button class="ap-btn ap-btn-sm" type="button" onclick={openConnect}>Connect to a backend</button>
			</div>
		{/if}
	</main>

	{#if feedback.current}
		<div class="toast">
			<StatusBanner tone={feedback.current.kind === 'error' ? 'danger' : 'warn'} role={feedback.current.kind === 'error' ? 'alert' : 'status'}>{feedback.current.text}</StatusBanner>
		</div>
	{/if}
	{#if snapshot.error && !(session.connection === 'reconnecting' && !session.reconnectError)}
		<div class="toast toast-right">
			<StatusBanner tone="danger" role="alert">{snapshot.error}</StatusBanner>
		</div>
	{/if}
</div>
{/if}

<style>
	/* App glue over the Apron design system: layout height, the sidebar's collapse and the
	   phone's one-pane-at-a-time. Everything else is ap-* from apron.css, inside the components. */
	:global(html), :global(body) { height: 100%; }
	:global(*), :global(*::before), :global(*::after) { box-sizing: border-box; }
	:global(button), :global(input), :global(textarea), :global(select) { font: inherit; }
	.app { height: 100dvh; min-height: 100%; position: relative; }
	.side-collapsed :global(.ap-shell-side) { border-right: 0; visibility: hidden; }
	.side-resizing, .side-resizing :global(*) { user-select: none; }
	.banner { padding: var(--space-2) var(--space-4) 0; }
	.demo-notice :global(.ap-status) { color: var(--ink-muted); }
	.reconnect-quiet { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-4) 0; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
	.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-8); color: var(--ink-muted); text-align: center; }
	.empty h2 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; color: var(--ink); }
	.empty p { margin: 0; }
	.empty .ap-btn { margin-top: var(--space-2); }
	.ap-summary-text :global(p) { margin: 0; }
	.ap-summary-text :global(p + p) { margin-top: var(--space-1); }
	.typing-row { min-height: 20px; padding-top: var(--space-1); }
	.toast { position: fixed; z-index: 10; left: 50%; bottom: calc(var(--space-4) + 64px); transform: translateX(-50%); max-width: min(480px, calc(100% - var(--space-8))); }
	.toast :global(.ap-status) { box-shadow: var(--shadow-float); }
	.toast-right { left: auto; right: var(--space-4); transform: none; }

	/* Under 720px it's one pane at a time: rooms, then the room or thread, pushed like pages. */
	@media (max-width: 719px) {
		.app { grid-template-columns: minmax(0, 1fr); }
		.app[data-pane='main'] :global(.ap-shell-side) { display: none; }
		.app[data-pane='rooms'] .ap-shell-main { display: none; }
		.side-collapsed :global(.ap-shell-side) { visibility: visible; }
		.typing-row { display: none; }
		.toast-right { right: var(--space-4); left: var(--space-4); max-width: none; }
	}
</style>
