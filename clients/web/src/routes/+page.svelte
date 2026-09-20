<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ChatClient,
		defaultWebSocketUrl,
		normalizeWebSocketUrl,
		timelineMessages,
		type ClientSnapshot,
		type OperationHandle,
		type RoomSnapshot
	} from '$lib/protocol/client';
	import { formatBytes, renderMarkdown, safeUrl } from '$lib/protocol/markdown';
	import { isJsonObject, type Embed, type MessageRecord, type Identity, type ThreadAnnouncement } from '$lib/protocol/types';

	type Feedback = { kind: 'pending' | 'error'; text: string };
	type PendingThreadStart = { room: string; thread_id: string };
	type ThreadListEntry = ThreadAnnouncement & {
		count: number;
		announced: boolean;
		participants: Identity[];
		lastReply: string;
	};
	type TimelineItem =
		| { kind: 'date'; key: string; label: string }
		| { kind: 'message'; key: string; event: MessageRecord; grouped: boolean }
		| { kind: 'thread'; key: string; entry: ThreadListEntry }
		| { kind: 'replies'; key: string; count: number };
	type ProfileStatus = 'idle' | 'saving' | 'altered' | 'declined';

	const GROUP_WINDOW_MS = 5 * 60 * 1000;

	const blankSnapshot = (): ClientSnapshot => ({
		status: 'idle', rooms: [], pending: [], typing: [], showReconnectDivider: false
	});

	let snapshot = $state<ClientSnapshot>(blankSnapshot());
	let serverInput = $state('');
	let displayName = $state('');
	let composerText = $state('');
	let connectOpen = $state(false);
	let profileOpen = $state(false);
	let profileDraft = $state('');
	let profileStatus = $state<ProfileStatus>('idle');
	let profileServerName = $state('');
	let editingId = $state<string | undefined>();
	let editDraft = $state('');
	let feedback = $state<Feedback | undefined>();
	let activeThread = $state<string | undefined>();
	let selectedRoomId = $state<string | undefined>();
	let drafts = $state<Record<string, string>>({});
	let replyDrafts = $state<Record<string, string | undefined>>({});
	let replyId = $state<string | undefined>();
	let pendingThreadStarts = $state<Record<string, PendingThreadStart>>({});
	let movingId = $state<string | undefined>();
	let moreId = $state<string | undefined>();
	let mobilePane = $state<'rooms' | 'main'>('main');
	let client: ChatClient | undefined;
	let composer = $state<HTMLTextAreaElement | undefined>();
	let messageScroll = $state<HTMLDivElement | undefined>();
	let stickToBottom = $state(true);
	let seenCount = $state(0);
	let typingTimer: ReturnType<typeof setTimeout> | undefined;
	let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

	let activeRoom = $derived(snapshot.rooms.find((room) => room.id === snapshot.activeRoom));
	let allMessages = $derived(timelineMessages(activeRoom));
	let roomMessages = $derived(allMessages.filter((event) => !event.thread_id));
	let messages = $derived(activeThread ? allMessages.filter((event) => event.thread_id === activeThread) : roomMessages);
	let threadEntries = $derived.by((): ThreadListEntry[] => {
		const entries = new Map<string, ThreadListEntry>();
		for (const announcement of activeRoom?.threads ?? []) {
			const root = announcement.root_message_id ? activeRoom?.timeline.events[announcement.root_message_id] : undefined;
			const excerpt = root && !root.deleted ? textOf(root).replace(/\s+/g, ' ').trim().slice(0, 60) : '';
			const name = announcement.title && announcement.title !== announcement.thread_id
				? announcement.title : excerpt || announcement.thread_id;
			entries.set(announcement.thread_id, { ...announcement, title: name, count: 0, announced: true, participants: [], lastReply: '' });
		}
		for (const event of allMessages) {
			if (!event.thread_id) continue;
			let entry = entries.get(event.thread_id);
			if (!entry) {
				entry = {
					room_id: activeRoom?.id ?? '',
					thread_id: event.thread_id,
					title: event.thread_id,
					count: 0,
					announced: false,
					participants: [],
					lastReply: ''
				};
				entries.set(event.thread_id, entry);
			}
			entry.count += 1;
			entry.lastReply = eventTime(event);
			if (event.from?.user_id && !event.deleted) {
				entry.participants = [event.from, ...entry.participants.filter((sender) => sender.user_id !== event.from?.user_id)].slice(0, 4);
			}
		}
		return [...entries.values()];
	});
	let threadEntriesById = $derived.by(() => new Map(threadEntries.map((entry) => [entry.thread_id, entry])));
	let threadsByRoot = $derived.by(() => {
		const byRoot = new Map<string, ThreadListEntry>();
		for (const entry of threadEntries) if (entry.announced && entry.root_message_id) byRoot.set(entry.root_message_id, entry);
		return byRoot;
	});
	let activeThreadAnnouncement = $derived.by(() => {
		const entry = activeThread ? threadEntriesById.get(activeThread) : undefined;
		return entry?.announced ? entry : undefined;
	});
	let timeline = $derived.by((): TimelineItem[] => {
		const items: TimelineItem[] = [];
		let lastDay = '';
		let previous: MessageRecord | undefined;
		const pushDate = (event: MessageRecord) => {
			const day = dayKey(event);
			if (day && day !== lastDay) {
				items.push({ kind: 'date', key: `date:${day}`, label: dayLabel(event) });
				lastDay = day;
				previous = undefined;
			}
		};
		const pushMessage = (event: MessageRecord) => {
			pushDate(event);
			items.push({ kind: 'message', key: event.message_id, event, grouped: isGrouped(previous, event) });
			previous = event;
		};
		if (activeThread) {
			const root = activeThreadAnnouncement?.root_message_id;
			const [first, ...rest] = messages;
			if (first && first.message_id === root) {
				items.push({ kind: 'message', key: first.message_id, event: first, grouped: false });
				lastDay = dayKey(first);
				if (rest.length > 0) items.push({ kind: 'replies', key: 'replies', count: rest.length });
				for (const event of rest) pushMessage(event);
			} else {
				for (const event of messages) pushMessage(event);
			}
			return items;
		}
		for (const event of allMessages) {
			if (!event.thread_id) {
				pushMessage(event);
				continue;
			}
			const entry = threadsByRoot.get(event.message_id);
			if (entry) {
				pushDate(event);
				items.push({ kind: 'thread', key: `thread:${entry.thread_id}`, entry });
				previous = undefined;
			}
		}
		return items;
	});
	let canCompose = $derived(Boolean(
		activeRoom && snapshot.status === 'connected' && snapshot.you &&
		(!activeThread || Boolean(activeThreadAnnouncement))
	));
	let canEdit = $derived(snapshot.server?.caps?.includes('edit') === true);
	let replyTarget = $derived(replyId ? activeRoom?.timeline.events[replyId] : undefined);
	let replyTargetMoved = $derived(Boolean(replyTarget && replyTarget.thread_id !== activeThread));
	let canUpload = $derived(typeof snapshot.server?.upload === 'string' && snapshot.server.upload.length > 0);
	let roomTyping = $derived(snapshot.typing.filter((entry) => entry.room === activeRoom?.id && entry.from.user_id !== snapshot.you?.user_id));
	let typingNames = $derived(roomTyping.map((entry) => entry.from.name || entry.from.user_id));
	let backendLabel = $derived(snapshot.server?.name || backendHost(serverInput) || 'Apron');
	let unseenCount = $derived(stickToBottom ? 0 : Math.max(0, messages.length - seenCount));
	let connectionState = $derived.by((): 'connected' | 'connecting' | 'reconnecting' | 'offline' | 'error' => {
		if (snapshot.status === 'connected' && snapshot.you) return 'connected';
		if (snapshot.status === 'connecting' || snapshot.status === 'connected') return 'connecting';
		if (snapshot.status === 'reconnecting') return 'reconnecting';
		if (snapshot.status === 'offline') return 'offline';
		return 'connecting';
	});

	$effect(() => {
		const roomId = activeRoom?.id;
		if (roomId && selectedRoomId !== roomId) setDestination(roomId, undefined);
	});

	$effect(() => {
		const room = activeRoom;
		if (!room) return;
		for (const [eventId, pending] of Object.entries(pendingThreadStarts)) {
			if (pending.room !== room.id) continue;
			const event = room.timeline.events[eventId];
			if (!event) continue;
			if (event.thread_id === pending.thread_id) {
				const next = { ...pendingThreadStarts };
				delete next[eventId];
				pendingThreadStarts = next;
				setDestination(room.id, pending.thread_id);
				break;
			}
			if (event.thread_id) {
				const next = { ...pendingThreadStarts };
				delete next[eventId];
				pendingThreadStarts = next;
			}
		}
	});

	$effect(() => {
		if (editingId && (!activeRoom?.timeline.events[editingId] || activeRoom.timeline.events[editingId].deleted || !messages.some((event) => event.message_id === editingId))) {
			editingId = undefined;
			editDraft = '';
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

	onMount(() => {
		const savedUrl = localStorage.getItem('bottomless.serverUrl') ?? defaultWebSocketUrl(window.location);
		const savedName = localStorage.getItem('bottomless.displayName') ?? '';
		serverInput = savedUrl;
		displayName = savedName;
		client = new ChatClient(normalizeWebSocketUrl(savedUrl, window.location), savedName);
		const unsubscribe = client.subscribe((next) => (snapshot = next));
		client.start();
		return () => {
			if (typingTimer) clearTimeout(typingTimer);
			if (feedbackTimer) clearTimeout(feedbackTimer);
			unsubscribe();
			client?.stop();
		};
	});

	function statusLabel(): string {
		if (snapshot.status === 'connected' && snapshot.you) return 'Connected';
		if (snapshot.status === 'connecting' || snapshot.status === 'connected') return 'Connecting…';
		if (snapshot.status === 'reconnecting') return 'Connection lost. Reconnecting…';
		if (snapshot.status === 'offline') return 'Offline';
		return 'Waiting to connect';
	}

	function backendHost(value: string): string {
		try {
			return new URL(value).host;
		} catch {
			return '';
		}
	}

	function applyConnection(event: SubmitEvent): void {
		event.preventDefault();
		if (!client) return;
		try {
			const normalized = normalizeWebSocketUrl(serverInput, window.location);
			const parsed = new URL(normalized);
			if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('Use a ws:// or wss:// URL');
			saveCurrentDraft();
			selectedRoomId = undefined;
			activeThread = undefined;
			pendingThreadStarts = {};
			movingId = undefined;
			moreId = undefined;
			composerText = '';
			replyId = undefined;
			serverInput = normalized;
			localStorage.setItem('bottomless.serverUrl', normalized);
			client.setUrl(normalized);
			connectOpen = false;
		} catch (cause) {
			feedback = { kind: 'error', text: cause instanceof Error ? cause.message : 'Invalid server URL' };
		}
	}

	function openProfile(): void {
		if (profileOpen) {
			closeProfile();
			return;
		}
		profileDraft = snapshot.you?.name || displayName;
		profileStatus = 'idle';
		profileServerName = '';
		profileOpen = true;
	}

	function closeProfile(): void {
		profileOpen = false;
		profileStatus = 'idle';
	}

	function saveProfile(event: SubmitEvent): void {
		event.preventDefault();
		if (!client) return;
		const requested = profileDraft.trim();
		if (!requested) return;
		displayName = requested;
		localStorage.setItem('bottomless.displayName', requested);
		const handle = client.setDisplayName(requested);
		if (!handle) {
			closeProfile();
			return;
		}
		profileStatus = 'saving';
		handle.promise
			.then((result) => {
				const kept = isJsonObject(result.you) && typeof result.you.name === 'string' ? result.you.name : requested;
				if (kept === requested) {
					closeProfile();
				} else {
					profileServerName = kept;
					profileStatus = 'altered';
				}
			})
			.catch(() => {
				profileStatus = 'declined';
			});
	}

	function chooseRoom(room: RoomSnapshot): void {
		client?.selectRoom(room.id);
		setDestination(room.id, undefined);
		mobilePane = 'main';
		composer?.focus();
	}

	function draftKey(serverUrl: string, roomId: string, thread: string | undefined): string {
		return JSON.stringify([serverUrl, roomId, thread ?? null]);
	}

	function currentServerUrl(): string {
		return client?.url ?? serverInput;
	}

	function saveCurrentDraft(): void {
		if (!selectedRoomId) return;
		const key = draftKey(currentServerUrl(), selectedRoomId, activeThread);
		drafts = { ...drafts, [key]: composerText };
		replyDrafts = { ...replyDrafts, [key]: replyId };
	}

	function setDestination(roomId: string, thread: string | undefined): void {
		if (selectedRoomId === roomId && activeThread === thread) return;
		saveCurrentDraft();
		selectedRoomId = roomId;
		activeThread = thread;
		const key = draftKey(currentServerUrl(), roomId, thread);
		composerText = drafts[key] ?? '';
		replyId = replyDrafts[key];
		editingId = undefined;
		editDraft = '';
		movingId = undefined;
		moreId = undefined;
		stickToBottom = true;
	}

	function chooseThread(thread: string): void {
		if (!activeRoom) return;
		setDestination(activeRoom.id, thread);
		client?.loadThread(activeRoom.id, thread).catch((cause: Error) => { feedback = { kind: 'error', text: cause.message }; });
		mobilePane = 'main';
		composer?.focus();
	}

	function backToRoom(): void {
		if (!activeRoom) return;
		setDestination(activeRoom.id, undefined);
		composer?.focus();
	}

	function composerInput(): void {
		if (!client || !activeRoom) return;
		if (selectedRoomId) {
			const key = draftKey(currentServerUrl(), selectedRoomId, activeThread);
			drafts = { ...drafts, [key]: composerText };
		}
		client.sendTyping(activeRoom.id, true);
		if (typingTimer) clearTimeout(typingTimer);
		typingTimer = setTimeout(() => client?.sendTyping(activeRoom?.id ?? '', false), 5000);
	}

	function composerKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			sendMessage();
		}
	}

	function sendMessage(): void {
		if (!client || !activeRoom || !canCompose || replyTargetMoved || !composerText.trim()) return;
		const draft = composerText;
		const roomId = activeRoom.id;
		const thread = activeThread;
		const reply = replyId;
		const originKey = draftKey(currentServerUrl(), roomId, thread);
		const handle = client.sendMessage(roomId, draft, 'markdown', thread, reply);
		track(handle, 'Sending…', () => {
			const currentKey = selectedRoomId ? draftKey(currentServerUrl(), selectedRoomId, activeThread) : undefined;
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
		composerText = '';
		replyId = undefined;
		drafts = { ...drafts, [originKey]: '' };
		replyDrafts = { ...replyDrafts, [originKey]: undefined };
		client.sendTyping(roomId, false);
		if (typingTimer) clearTimeout(typingTimer);
		stickToBottom = true;
		composer?.focus();
	}

	function beginReply(event: MessageRecord): void {
		if (!canCompose || event.deleted || event.thread_id !== activeThread) return;
		replyId = event.message_id;
		moreId = undefined;
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
		return `${senderName(target)}: ${textOf(target).replace(/\s+/g, ' ').trim().slice(0, 160) || 'Attachment'}`;
	}

	function removeReply(event: MessageRecord): void {
		if (!client || !activeRoom || !canEdit || !isOwn(event)) return;
		moreId = undefined;
		track(client.setMessageReply(activeRoom.id, event.message_id, null), 'Removing reply reference…');
	}

	function beginEdit(event: MessageRecord): void {
		editingId = event.message_id;
		editDraft = typeof event.body?.text === 'string' ? event.body.text : '';
		moreId = undefined;
	}

	function editKeydown(event: KeyboardEvent, record: MessageRecord): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			editingId = undefined;
		} else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			saveEdit(record);
		}
	}

	function saveEdit(event: MessageRecord): void {
		if (!client || !activeRoom || !canEdit || !editDraft.trim()) return;
		track(client.updateMessage(activeRoom.id, event.message_id, editDraft), 'Saving edit…');
		editingId = undefined;
		editDraft = '';
	}

	function deleteMessage(event: MessageRecord): void {
		if (!client || !activeRoom || !canEdit) return;
		moreId = undefined;
		if (!confirm('Delete this message? This cannot be undone.')) return;
		track(client.deleteMessage(activeRoom.id, event.message_id), 'Deleting message…');
	}

	async function startThread(event: MessageRecord): Promise<void> {
		if (!client || !activeRoom || !canEdit || !isOwn(event) || event.deleted || event.thread_id) return;
		const session = client;
		const roomId = activeRoom.id;
		pendingThreadStarts = { ...pendingThreadStarts, [event.message_id]: { room: roomId, thread_id: '' } };
		feedback = { kind: 'pending', text: 'Starting thread…' };
		try {
			const result = await session.createThread(roomId, { root_message_id: event.message_id }).promise;
			if (typeof result.thread_id !== 'string') throw new Error('Invalid thread response');
			pendingThreadStarts = { ...pendingThreadStarts, [event.message_id]: { room: roomId, thread_id: result.thread_id } };
			await session.setMessageThread(roomId, event.message_id, result.thread_id).promise;
			feedback = undefined;
		} catch (cause) {
			const next = { ...pendingThreadStarts };
			delete next[event.message_id];
			pendingThreadStarts = next;
			feedback = { kind: 'error', text: cause instanceof Error ? cause.message : 'Unable to start thread' };
		}
	}

	function toggleMove(event: MessageRecord): void {
		movingId = movingId === event.message_id ? undefined : event.message_id;
		moreId = undefined;
	}

	function moveMessage(event: MessageRecord, value: string, select?: HTMLSelectElement): void {
		if (!client || !activeRoom || !canEdit || !isOwn(event) || event.deleted) return;
		const thread = value || null;
		if (thread === event.thread_id) return;
		if (thread && !activeRoom.threads.some((entry) => entry.thread_id === thread)) return;
		if (select) select.value = event.thread_id ?? '';
		movingId = undefined;
		track(client.setMessageThread(activeRoom.id, event.message_id, thread), 'Moving message…');
	}

	/** Shows "pending" copy only when a request takes noticeably long, and errors until the next request. */
	function track(handle: OperationHandle, pendingText: string, onError?: () => void): void {
		if (feedbackTimer) clearTimeout(feedbackTimer);
		feedback = undefined;
		feedbackTimer = setTimeout(() => (feedback = { kind: 'pending', text: pendingText }), 600);
		handle.promise
			.then(() => {
				if (feedbackTimer) clearTimeout(feedbackTimer);
				feedback = undefined;
			})
			.catch((cause: Error) => {
				if (feedbackTimer) clearTimeout(feedbackTimer);
				feedback = { kind: 'error', text: cause.message };
				onError?.();
			});
	}

	function isOwn(event: MessageRecord): boolean {
		return Boolean(snapshot.you && event.from?.user_id === snapshot.you.user_id);
	}

	function senderName(event: MessageRecord): string {
		return event.from?.name || event.from?.user_id || 'Unknown sender';
	}

	function initials(name: string): string {
		const parts = name.trim().split(/\s+/);
		const first = parts[0]?.[0] ?? '?';
		const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
		return (first + last).toUpperCase();
	}

	function eventMillis(event: MessageRecord): number | undefined {
		const millis = Number(event.message_id);
		return Number.isSafeInteger(millis) && millis > 0 ? millis : undefined;
	}

	function eventTime(event: MessageRecord): string {
		const millis = eventMillis(event);
		return millis
			? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(millis)
			: '';
	}

	function dayKey(event: MessageRecord): string {
		const millis = eventMillis(event);
		if (!millis) return '';
		const date = new Date(millis);
		return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
	}

	function dayLabel(event: MessageRecord): string {
		const millis = eventMillis(event);
		if (!millis) return '';
		const date = new Date(millis);
		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
		if (sameDay(date, today)) return 'Today';
		if (sameDay(date, yesterday)) return 'Yesterday';
		return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
	}

	function isGrouped(previous: MessageRecord | undefined, event: MessageRecord): boolean {
		if (!previous || !previous.from?.user_id || previous.from.user_id !== event.from?.user_id) return false;
		const before = eventMillis(previous);
		const after = eventMillis(event);
		return before !== undefined && after !== undefined && after - before < GROUP_WINDOW_MS;
	}

	function mentionsMe(event: MessageRecord): boolean {
		const me = snapshot.you;
		if (!me || isOwn(event)) return false;
		const text = textOf(event);
		if (!text) return false;
		return [me.name, me.user_id].some((handle) => handle && text.includes(`@${handle}`));
	}

	function textOf(event: MessageRecord): string {
		return typeof event.body?.text === 'string' ? event.body.text : '';
	}

	function threadTitle(thread: string): string {
		return threadEntriesById.get(thread)?.title || thread;
	}

	function threadSummary(thread: string): string | undefined {
		return threadEntriesById.get(thread)?.summary;
	}

	function isThreadAnnounced(thread: string): boolean {
		return threadEntriesById.get(thread)?.announced === true;
	}

	function embedsOf(event: MessageRecord): Embed[] {
		return Array.isArray(event.body?.embeds)
			? event.body.embeds.filter(isJsonObject).filter((embed): embed is Embed => typeof embed.kind === 'string')
			: [];
	}

	function aspectRatio(embed: Embed): string | undefined {
		return typeof embed.w === 'number' && typeof embed.h === 'number' && embed.w > 0 && embed.h > 0
			? `aspect-ratio: ${embed.w} / ${embed.h}`
			: undefined;
	}

	function trackScroll(): void {
		if (!messageScroll) return;
		const atBottom = messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight < 96;
		if (!atBottom && stickToBottom) seenCount = messages.length;
		stickToBottom = atBottom;
	}

	function jumpToLatest(): void {
		stickToBottom = true;
		if (messageScroll) messageScroll.scrollTop = messageScroll.scrollHeight;
	}

	function hasActions(event: MessageRecord): boolean {
		return canEdit && isOwn(event) && !event.deleted;
	}

	function canRemoveReply(event: MessageRecord): boolean {
		return canEdit && isOwn(event) && Boolean(event.reply_message_id);
	}

	function canMove(event: MessageRecord): boolean {
		return Boolean(event.thread_id || (activeRoom && activeRoom.threads.length > 0));
	}
</script>

<svelte:head>
	<title>Apron</title>
	<meta name="description" content="Apron, a chat frontend for the Bottomless Chat protocol." />
</svelte:head>

<div class="app ap-shell ap-shell-norail" data-pane={mobilePane}>
	<aside class="ap-shell-side" aria-label="Rooms">
		<div class="ap-shell-sidehead">
			<span class="app-backend">{backendLabel}</span>
			<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" aria-label="Connection settings" aria-expanded={connectOpen} onclick={() => (connectOpen = !connectOpen)}>Connect</button>
		</div>
		{#if connectOpen}
			<form class="app-connect ap-profedit" aria-label="Connection settings" onsubmit={applyConnection}>
				<label class="ap-fieldlabel">Server URL
					<input class="ap-field" data-testid="server-url-input" bind:value={serverInput} placeholder="ws://localhost:8080/ws" autocomplete="url" spellcheck="false" />
				</label>
				<p class="ap-profedit-hint">A WebSocket URL, or the HTTP address of a server that speaks the protocol.</p>
				<div class="ap-profedit-actions">
					<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" onclick={() => (connectOpen = false)}>Cancel</button>
					<button class="ap-btn ap-btn-primary ap-btn-sm" type="submit">Reconnect</button>
				</div>
			</form>
		{/if}
		<div class="ap-shell-sidebody">
			<section class="ap-sect">
				<div class="ap-sect-head">
					<span class="ap-sect-toggle" role="heading" aria-level="2">Rooms</span>
				</div>
				<div class="ap-sect-body" data-testid="room-list">
					{#if snapshot.rooms.length === 0}
						<p class="app-muted">{snapshot.status === 'connected' ? 'No rooms yet.' : 'Waiting for rooms…'}</p>
					{:else}
						{#each snapshot.rooms as room (room.id)}
							{@const active = room.id === snapshot.activeRoom}
							<button class="ap-room" class:ap-room-active={active && !activeThread} type="button" data-room={room.id} aria-current={active && !activeThread ? 'page' : undefined} onclick={() => chooseRoom(room)}>
								<span class="ap-room-text">
									<span class="ap-room-name">{room.name}</span>
									{#if room.topic}<span class="ap-room-topic">{room.topic}</span>{/if}
								</span>
								{#if room.recovering}<span class="app-room-meta" aria-label="Loading history">…</span>{/if}
							</button>
							{#if active}
								<div class="app-threads" data-testid="thread-list" role="group" aria-label={`Threads in ${room.name}`}>
									{#each threadEntries as entry (entry.thread_id)}
										<button class="ap-room ap-room-nested" class:ap-room-active={activeThread === entry.thread_id} type="button" data-thread={entry.thread_id} aria-current={activeThread === entry.thread_id ? 'page' : undefined} onclick={() => chooseThread(entry.thread_id)}>
											<span class="ap-room-text"><span class="ap-room-name">{entry.title || entry.thread_id}</span></span>
											<small class="app-room-meta" aria-label={`${entry.count} ${entry.count === 1 ? 'message' : 'messages'}`}>{entry.count}</small>
										</button>
									{/each}
								</div>
							{/if}
						{/each}
					{/if}
				</div>
			</section>
		</div>
		<div class="ap-profile">
			{#if profileOpen}
				<div class="ap-profile-pop" role="dialog" aria-label="Edit profile">
					<form class="ap-profedit" onsubmit={saveProfile}>
						<div class="ap-profedit-top">
							{#if snapshot.you?.avatar && safeUrl(snapshot.you.avatar)}
								<img class="ap-avatar ap-avatar-lg" src={snapshot.you.avatar} alt="" />
							{:else}
								<span class="ap-avatar ap-avatar-lg" aria-hidden="true">{initials(profileDraft || snapshot.you?.user_id || '?')}</span>
							{/if}
							<div class="ap-profedit-av">
								<span class="ap-profedit-hint">{canUpload ? 'Avatar uploads are not supported by this client yet.' : 'This backend has no upload URL, so your avatar can’t be set here.'}</span>
							</div>
						</div>
						<label class="ap-fieldlabel">Handle
							<input class="ap-field" data-testid="display-name-input" bind:value={profileDraft} disabled={profileStatus === 'saving'} maxlength="64" autocomplete="nickname" spellcheck="false" />
						</label>
						<p class="ap-profedit-hint">ID <code>{snapshot.you?.user_id ?? '—'}</code> · set by the server, can’t be changed</p>
						{#if profileStatus === 'altered'}
							<p class="ap-profedit-note" role="status">The server saved your handle as “{profileServerName}”.</p>
						{:else if profileStatus === 'declined'}
							<p class="ap-profedit-note ap-profedit-err" role="alert">The server declined this handle. Your old one is still in use.</p>
						{/if}
						<div class="ap-profedit-actions">
							<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" disabled={profileStatus === 'saving'} onclick={closeProfile}>{profileStatus === 'altered' ? 'Close' : 'Cancel'}</button>
							<button class="ap-btn ap-btn-primary ap-btn-sm" type="submit" disabled={profileStatus === 'saving' || !profileDraft.trim()}>{profileStatus === 'saving' ? 'Saving…' : 'Save'}</button>
						</div>
					</form>
				</div>
			{/if}
			<button class="ap-profile-me" class:ap-profile-open={profileOpen} type="button" aria-haspopup="dialog" aria-expanded={profileOpen} aria-label={`Your profile on ${backendLabel}: ${snapshot.you?.name || snapshot.you?.user_id || 'not signed in'}. Edit`} onclick={openProfile}>
				{#if snapshot.you?.avatar && safeUrl(snapshot.you.avatar)}
					<img class="ap-avatar ap-avatar-md" src={snapshot.you.avatar} alt="" />
				{:else}
					<span class="ap-avatar ap-avatar-md" aria-hidden="true">{initials(snapshot.you?.name || snapshot.you?.user_id || '?')}</span>
				{/if}
				<span class="ap-profile-text">
					<span class="ap-profile-name">{snapshot.you?.name || snapshot.you?.user_id || 'Not signed in'}</span>
					<span class="ap-profile-sub">on {backendLabel}</span>
				</span>
				<span class="ap-profile-edit" aria-hidden="true">Edit</span>
			</button>
		</div>
	</aside>

	<main class="ap-shell-main" aria-label="Conversation">
		{#if activeRoom}
			<header class="ap-roomhead">
				<button class="ap-roomhead-back" type="button" aria-label="Back to rooms" onclick={() => (mobilePane = 'rooms')}>‹</button>
				<div class="ap-roomhead-text">
					{#if activeThread}
						<h1 class="ap-roomhead-name">
							<button class="ap-roomhead-crumb" type="button" aria-label="Back to room" onclick={backToRoom}>{activeRoom.name}</button>
							<span class="ap-roomhead-sep" aria-hidden="true"> › </span>
							{threadTitle(activeThread)}
						</h1>
					{:else}
						<h1 class="ap-roomhead-name">{activeRoom.name}</h1>
					{/if}
					{#if typingNames.length > 0}
						<p class="ap-roomhead-sub ap-roomhead-typing app-typing-head">{typingNames.length === 1 ? `${typingNames[0]} is typing…` : `${typingNames.length} people are typing…`}</p>
					{:else if activeThread ? threadSummary(activeThread) : activeRoom.topic}
						<p class="ap-roomhead-sub">{activeThread ? threadSummary(activeThread) : activeRoom.topic}</p>
					{/if}
				</div>
				{#if activeRoom.recovering}
					<span class="ap-roomhead-sub" role="status">Loading history…</span>
				{:else if activeRoom.recoveryError}
					<span class="ap-roomhead-sub" role="status">History unavailable</span>
				{/if}
			</header>

			{#if connectionState !== 'connected'}
				<div class="app-banner">
					<div class="ap-status" role="status">
						<span class="ap-status-dot" class:ap-status-warn={connectionState === 'connecting' || connectionState === 'reconnecting'} class:ap-status-danger={connectionState === 'offline' || connectionState === 'error'} aria-hidden="true"></span>
						<span class="ap-status-text" data-testid="connection-status" aria-live="polite">{statusLabel()}</span>
					</div>
				</div>
			{:else}
				<span class="app-sr" data-testid="connection-status" role="status" aria-live="polite">Connected</span>
			{/if}
			{#if activeThread && !activeThreadAnnouncement}
				<div class="app-banner">
					<div class="ap-status" role="status">
						<span class="ap-status-dot ap-status-danger" aria-hidden="true"></span>
						<span class="ap-status-text">This thread is no longer available on the server.</span>
						<button class="ap-btn ap-btn-sm" type="button" onclick={backToRoom}>Back to room</button>
					</div>
				</div>
			{/if}

			<div class="ap-timeline" bind:this={messageScroll} onscroll={trackScroll} data-testid="message-list" role="log" aria-live="polite" aria-label={`${activeThread ? threadTitle(activeThread) : activeRoom.name} messages`}>
				{#if snapshot.showReconnectDivider}
					<div class="ap-divider ap-divider-gap" role="separator" data-testid="reconnect-divider"><span>Reconnected · earlier messages aren’t available</span></div>
				{/if}
				{#if messages.length === 0 && !activeRoom.recovering}
					<div class="app-empty">
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
							{@const entry = item.entry}
							<div class="app-thread-row">
								<button class="ap-thread" type="button" onclick={() => chooseThread(entry.thread_id)}>
									{#if entry.participants.length > 0}
										<span class="ap-thread-faces" aria-hidden="true">
											{#each entry.participants as participant (participant.user_id)}
												{#if participant.avatar && safeUrl(participant.avatar)}
													<img class="ap-avatar ap-avatar-sm" src={participant.avatar} alt="" />
												{:else}
													<span class="ap-avatar ap-avatar-sm">{initials(participant.name || participant.user_id)}</span>
												{/if}
											{/each}
										</span>
									{/if}
									<span class="ap-thread-name">{entry.title}</span>
									<span class="ap-thread-count">{entry.count} {entry.count === 1 ? 'message' : 'messages'}</span>
									{#if entry.lastReply}<span class="ap-thread-last">Last reply {entry.lastReply}</span>{/if}
									{#if entry.summary}<span class="ap-thread-summary">{entry.summary}</span>{/if}
								</button>
							</div>
						{:else}
							{@const event = item.event}
							{@const name = senderName(event)}
							<article class="ap-msg" class:ap-msg-grouped={item.grouped} class:ap-msg-mention={mentionsMe(event)} data-message-id={event.message_id} tabindex="-1">
								<div class="ap-msg-gutter">
									{#if item.grouped}
										<span class="ap-msg-hovertime">{eventTime(event)}</span>
									{:else if event.from?.avatar && safeUrl(event.from.avatar)}
										<img class="ap-avatar ap-avatar-md" src={event.from.avatar} alt="" />
									{:else}
										<span class="ap-avatar ap-avatar-md" aria-hidden="true">{initials(name)}</span>
									{/if}
								</div>
								<div class="ap-msg-main">
									{#if !item.grouped}
										<header class="ap-msg-head">
											<span class="ap-msg-sender">{name}</span>
											<span class="ap-msg-meta">{#if eventTime(event)}<time>{eventTime(event)}</time>{/if}</span>
										</header>
									{/if}
									{#if event.reply_message_id && !event.deleted}
										<div class="app-reply-reference" data-testid="reply-reference">Replying to {replyPreview(event.reply_message_id)}</div>
									{/if}
									{#if event.deleted}
										<div class="ap-msg-tomb">Message deleted</div>
									{:else if editingId === event.message_id}
										<div class="app-edit">
											<textarea class="ap-field app-edit-field" aria-label="Edit message" bind:value={editDraft} rows="3" onkeydown={(keyEvent) => editKeydown(keyEvent, event)}></textarea>
											<div class="ap-profedit-actions">
												<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" onclick={() => (editingId = undefined)}>Cancel</button>
												<button class="ap-btn ap-btn-primary ap-btn-sm" type="button" onclick={() => saveEdit(event)}>Save changes</button>
											</div>
										</div>
									{:else}
										{#if textOf(event)}
											{#if event.body?.format === 'plain'}
												<div class="ap-msg-text app-plain">{textOf(event)}</div>
											{:else}
												<div class="ap-msg-text markdown">{@html renderMarkdown(textOf(event))}</div>
											{/if}
										{/if}
										{#if embedsOf(event).length > 0}
											<div class="ap-msg-embeds">
												{#each embedsOf(event) as embed}
													{@const url = safeUrl(embed.url)}
													{#if embed.kind === 'image' && url}
														<img class="ap-embed ap-embed-media" src={url} alt={embed.name || ''} loading="lazy" style={aspectRatio(embed)} />
													{:else if embed.kind === 'video' && url}
														<!-- svelte-ignore a11y_media_has_caption -->
														<video class="ap-embed ap-embed-media" src={url} controls preload="metadata" style={aspectRatio(embed)}></video>
													{:else if embed.kind === 'audio' && url}
														<audio class="ap-embed ap-embed-audio" src={url} controls preload="none"></audio>
													{:else if embed.kind === 'file' && url}
														<a class="ap-embed ap-embed-card" href={url} download={embed.name || true}>
															<span class="ap-embed-title">{embed.name || 'File'}</span>
															<span class="ap-embed-detail">{[embed.mime, formatBytes(embed.size)].filter(Boolean).join(' · ')}</span>
														</a>
													{:else}
														<div class="ap-embed ap-embed-card ap-embed-fallback">
															<span class="ap-embed-kind">{embed.kind || 'unknown'}</span>
															{#if url}<a class="ap-embed-url" href={url} rel="noreferrer noopener" target="_blank">{url}</a>{:else}<span class="ap-embed-detail">This client can’t display this embed.</span>{/if}
														</div>
													{/if}
												{/each}
											</div>
										{/if}
										{#if movingId === event.message_id}
											<div class="app-move">
												<label class="ap-fieldlabel">Move to
													<select class="ap-field" value={event.thread_id ?? ''} aria-label="Move message to" onchange={(change) => moveMessage(event, (change.currentTarget as HTMLSelectElement).value, change.currentTarget as HTMLSelectElement)}>
														<option value="">Move to room</option>
														{#if event.thread_id && !isThreadAnnounced(event.thread_id)}<option value={event.thread_id} disabled>Current thread unavailable</option>{/if}
														{#each activeRoom.threads as thread (thread.thread_id)}<option value={thread.thread_id}>{threadTitle(thread.thread_id)}</option>{/each}
													</select>
												</label>
												<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" onclick={() => (movingId = undefined)}>Cancel</button>
											</div>
										{/if}
									{/if}
								</div>
								{#if hasActions(event) || canRemoveReply(event) || (canCompose && !event.deleted)}
									<div class="ap-msg-actions">
										<div class="ap-actions" role="toolbar" aria-label="Message actions">
											{#if event.deleted && canRemoveReply(event)}
												<button class="ap-actions-btn" type="button" aria-label="Remove reply reference" onclick={() => removeReply(event)}>Remove reply</button>
											{/if}
											{#if canCompose && !event.deleted}
												<button class="ap-actions-btn" type="button" aria-label="Reply to message" onclick={() => beginReply(event)}>Reply</button>
											{/if}
											{#if hasActions(event)}
												{#if !event.thread_id && !activeThread}
													<button class="ap-actions-btn" type="button" data-testid="start-thread" aria-label="Start thread" title="Start thread" disabled={Boolean(pendingThreadStarts[event.message_id])} onclick={() => startThread(event)}>{pendingThreadStarts[event.message_id] ? 'Starting…' : 'Start thread'}</button>
												{/if}
												<button class="ap-actions-btn" type="button" aria-label="Edit message" title="Edit" onclick={() => beginEdit(event)}>Edit</button>
												{#if moreId === event.message_id}
													{#if event.reply_message_id}
														<button class="ap-actions-btn" type="button" aria-label="Remove reply reference" onclick={() => removeReply(event)}>Remove reply</button>
													{/if}
													{#if canMove(event)}
														<button class="ap-actions-btn" type="button" aria-label="Move message" title="Move to thread" onclick={() => toggleMove(event)}>Move</button>
													{/if}
													<button class="ap-actions-btn ap-actions-danger" type="button" aria-label="Delete message" title="Delete" onclick={() => deleteMessage(event)}>Delete</button>
												{:else}
													<button class="ap-actions-btn" type="button" aria-label="More actions" aria-expanded="false" title="More" onclick={() => (moreId = event.message_id)}>⋯</button>
												{/if}
											{/if}
										</div>
									</div>
								{/if}
							</article>
						{/if}
					{/each}
				{/if}
			</div>

			{#if unseenCount > 0 || !stickToBottom}
				<div class="app-jump">
					<div class="ap-jumpbar" role="status">
						<span class="ap-jumpbar-text">{unseenCount ? (unseenCount === 1 ? '1 new message' : `${unseenCount} new messages`) : 'You’re viewing older messages'}</span>
						<button class="ap-jumpbar-btn" type="button" onclick={jumpToLatest}>{unseenCount ? 'Jump to new' : 'Jump to latest'}</button>
					</div>
				</div>
			{/if}

			<div class="ap-typing app-typing-row" aria-live="polite">
				{#if typingNames.length > 0}
					<span class="ap-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
					{typingNames.length === 1 ? `${typingNames[0]} is typing` : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing` : 'Several people are typing'}…
				{/if}
			</div>

			{#if replyId}
				<div class="app-reply-draft" data-testid="reply-draft" role="status">
					<span>{replyTargetMoved ? 'This message moved to another thread. Cancel this reply to continue.' : `Replying to ${replyPreview(replyId)}`}</span>
					<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" aria-label="Cancel reply" onclick={cancelReply}>Cancel reply</button>
				</div>
			{/if}
			<form class="ap-composer" class:ap-composer-disabled={!canCompose} aria-label="Send a message" onsubmit={(event) => { event.preventDefault(); sendMessage(); }}>
				<textarea class="ap-composer-field" id="message-input" data-testid="message-input" aria-label="Message" bind:this={composer} bind:value={composerText} oninput={composerInput} onkeydown={composerKeydown} disabled={!canCompose} placeholder={activeThread ? `Reply in ${threadTitle(activeThread)}` : `Message ${activeRoom.name}`} rows="1"></textarea>
				<button class="ap-btn ap-btn-primary ap-btn-sm" data-testid="send-button" type="submit" aria-label="Send message" disabled={!canCompose || replyTargetMoved || !composerText.trim()}>Send</button>
			</form>
		{:else}
			<div class="app-empty app-empty-room">
				{#if connectionState !== 'connected'}
					<div class="ap-status" role="status">
						<span class="ap-status-dot" class:ap-status-warn={connectionState === 'connecting' || connectionState === 'reconnecting'} class:ap-status-danger={connectionState === 'offline' || connectionState === 'error'} aria-hidden="true"></span>
						<span class="ap-status-text" data-testid="connection-status" aria-live="polite">{statusLabel()}</span>
					</div>
				{:else}
					<span class="app-sr" data-testid="connection-status" role="status" aria-live="polite">Connected</span>
					<h2>No room open</h2>
					<p>Pick a room from the list.</p>
				{/if}
				<button class="ap-btn ap-btn-sm" type="button" onclick={() => (connectOpen = true)}>Connect to a backend</button>
			</div>
		{/if}
	</main>

	{#if feedback}
		<div class="app-toast">
			<div class="ap-status" role={feedback.kind === 'error' ? 'alert' : 'status'}>
				<span class="ap-status-dot" class:ap-status-warn={feedback.kind === 'pending'} class:ap-status-danger={feedback.kind === 'error'} aria-hidden="true"></span>
				<span class="ap-status-text">{feedback.text}</span>
			</div>
		</div>
	{/if}
	{#if snapshot.error}
		<div class="app-toast app-toast-right">
			<div class="ap-status" role="alert">
				<span class="ap-status-dot ap-status-danger" aria-hidden="true"></span>
				<span class="ap-status-text">{snapshot.error}</span>
			</div>
		</div>
	{/if}
</div>

<style>
	/* App glue over the Apron design system: layout height, mobile panes and the few
	   surfaces the component bundle doesn't cover. Everything else is ap-* from apron.css. */
	:global(html), :global(body) { height: 100%; }
	:global(*), :global(*::before), :global(*::after) { box-sizing: border-box; }
	:global(button), :global(input), :global(textarea), :global(select) { font: inherit; }
	.app { height: 100dvh; min-height: 100%; }
	.ap-actions { max-width: calc(100vw - 32px); flex-wrap: wrap; }
	.app-reply-reference { border-left: 2px solid currentColor; padding-left: var(--space-2); margin-bottom: var(--space-2); opacity: .75; font-size: .85em; overflow-wrap: anywhere; }
	.app-reply-draft { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-4); font-size: .85em; }
	.app-reply-draft span { min-width: 0; overflow-wrap: anywhere; }
	.app-backend { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ap-shell-sidehead { gap: var(--space-2); }
	.app-connect { margin: var(--space-2) var(--space-2) 0; }
	.app-muted { margin: 0; padding: var(--space-1) var(--space-3); color: var(--ink-muted); font-size: 13px; line-height: 18px; }
	.app-threads { display: flex; flex-direction: column; gap: 2px; }
	.app-room-meta { flex: none; font-size: 12px; line-height: 16px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
	.ap-room-active .app-room-meta { color: var(--ink); }
	.ap-roomhead-back { display: none; }
	.app-banner { padding: var(--space-2) var(--space-4) 0; }
	.app-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.app-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); padding: var(--space-8); color: var(--ink-muted); text-align: center; }
	.app-empty h2 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; color: var(--ink); }
	.app-empty p { margin: 0; }
	.app-empty .ap-btn { margin-top: var(--space-2); }
	.app-thread-row { margin: var(--space-2) var(--space-4) 0 calc(var(--space-4) + var(--avatar-md) + var(--space-3)); }
	.app-thread-row .ap-thread { margin-top: 0; flex-wrap: wrap; row-gap: 0; }
	.app-plain { white-space: pre-wrap; }
	.app-edit { display: flex; flex-direction: column; gap: var(--space-2); max-width: var(--timeline-max-w); }
	.app-edit-field { height: auto; min-height: 66px; padding: var(--space-2); resize: vertical; font-size: 15px; line-height: 22px; }
	.app-move { display: flex; align-items: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
	.app-move .ap-field { max-width: 240px; }
	.app-jump { display: flex; justify-content: center; margin-bottom: var(--space-2); }
	.app-jump .ap-jumpbar { width: min(100%, var(--timeline-max-w)); }
	.app-typing-row { min-height: 20px; padding-top: var(--space-1); }
	.app-typing-head { display: none; }
	.app-toast { position: fixed; z-index: 10; left: 50%; bottom: calc(var(--space-4) + 64px); transform: translateX(-50%); max-width: min(480px, calc(100% - var(--space-8))); }
	.app-toast .ap-status { box-shadow: var(--shadow-float); }
	.app-toast-right { left: auto; right: var(--space-4); transform: none; }

	/* Under 720px it's one pane at a time: rooms, then the room or thread, pushed like pages. */
	@media (max-width: 719px) {
		.app { grid-template-columns: minmax(0, 1fr); }
		.app[data-pane='main'] .ap-shell-side { display: none; }
		.app[data-pane='rooms'] .ap-shell-main { display: none; }
		.ap-shell-side { border-right: 0; }
		.ap-roomhead-back { display: block; }
		.app-typing-head { display: block; }
		.app-typing-row { display: none; }
		.app-thread-row { margin-left: var(--space-4); }
		.app-toast-right { right: var(--space-4); left: var(--space-4); max-width: none; }
	}
</style>
