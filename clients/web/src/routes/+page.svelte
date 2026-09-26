<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { passkeySupportError } from '$lib/protocol/webauthn';
	import { ChatClient, childRooms, defaultWebSocketUrl, findMessage, normalizeWebSocketUrl, timelineMessages, type RoomSnapshot } from '$lib/protocol/client';
	import { serverOrigin } from '$lib/protocol/embeds';
	import { compareLogIds } from '$lib/protocol/reducer';
	import type { MessageRecord } from '$lib/protocol/types';
	import Composer from '$lib/components/Composer.svelte';
	import ConnectScreen, { type Scheme } from '$lib/components/ConnectScreen.svelte';
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
	import NoticeLine from '$lib/components/NoticeLine.svelte';
	import { composerAction } from '$lib/ui/commands';
	import { backendHost, demoRetentionNotice, statusLabel } from '$lib/ui/connection';
	import { directory } from '$lib/ui/directory.svelte';
	import { FeedbackState } from '$lib/ui/feedback.svelte';
	import { MentionTracker } from '$lib/ui/mentions.svelte';
	import { UnreadTracker } from '$lib/ui/unread.svelte';
	import { isOwn, mentionsMe, peopleIn, replySnippet, senderName } from '$lib/ui/messages';
	import { reactionChips, type ReactionChip } from '$lib/ui/reactions';
	import { MessageSelection } from '$lib/ui/selection.svelte';
	import { SessionView } from '$lib/ui/session.svelte';
	import { SidebarLayout } from '$lib/ui/sidebar.svelte';
	import { loadDisplayName, loadRecentServers, loadServerUrl, rememberServer, saveDisplayName, type RecentServer } from '$lib/ui/storage';
	import { buildRoomTimeline, buildThreadTimeline, threadEntries, threadTitleFor } from '$lib/ui/timeline';
	import { dayLabelOf, idDateTime, idIso, idTime } from '$lib/ui/time';
	import { playPing, tabTitle } from '$lib/ui/attention';

	/** A thread this viewer created, opened once its `room_update` has arrived. */
	type PendingOpen = { room: string; thread: string };

	/** A thread just chosen: where it lands waits until its first load shows whether older replies remain. */
	let openingThread = $state<string | undefined>();
	/** How near the top of a thread reading back starts loading its older replies. */
	const OLDER_REPLIES_MARGIN_PX = 240;

	/** How long a jump waits for its target to render (a thread's history may still be loading). */
	const JUMP_WAIT_MS = 4000;
	/**
	 * Opening a room renders its newest items first, enough to fill the pane,
	 * and the older ones a chunk per frame after that paints, so switching
	 * rooms shows the room without waiting for its whole history to render.
	 */
	const FIRST_PAINT_ITEMS = 40;
	const REVEAL_CHUNK_ITEMS = 60;
	/** How long a members listing stays current when the mention picker opens. */
	const MEMBERS_FRESH_MS = 15_000;
	/** The shortest gap between listings made because the pane has no members. */
	const MEMBERS_RETRY_MS = 10_000;

	const session = new SessionView();
	const feedback = new FeedbackState();
	const mentions = new MentionTracker();
	const unread = new UnreadTracker();
	/** Whether this tab is in front: a hidden tab doesn't read what arrives. */
	let pageVisible = $state(typeof document === 'undefined' || document.visibilityState === 'visible');
	/** Whether this window has focus: a mention while it doesn't alerts the tab. */
	let pageFocused = $state(typeof document === 'undefined' || document.hasFocus());
	/** A mention arrived while you were away; the title flashes until you're back. */
	let attention = $state(false);
	let titleFlash = $state(false);
	let alertedMentions = 0;
	/** The day at the top of the timeline, floated there only while you scroll back. */
	let floatingDay = $state('');
	let floatingDayShown = $state(false);
	let floatingDayTimer: ReturnType<typeof setTimeout> | undefined;
	const selection = new MessageSelection();
	const sidebar = new SidebarLayout();

	let client = $state<ChatClient | undefined>();
	let serverInput = $state('');
	let displayName = $state('');
	let composerText = $state('');
	/** The `user_id`s the composer's chips mention (§3.5), sent as `body.mentions`. */
	let composerMentions = $state<string[]>([]);
	let connectOpen = $state(false);
	/** The sign-in scheme the connect screen opens with, when something asked for one. */
	let connectScheme = $state<Scheme | undefined>();
	let recentServers = $state<RecentServer[]>([]);
	let passkeyUnavailable = $state<string | undefined>();
	let highlightedId = $state<string | undefined>();
	let editingId = $state<string | undefined>();
	let threadEditorOpen = $state(false);
	/** The open thread's `room_id`; undefined in the room view. */
	let activeThread = $state<string | undefined>();
	let selectedRoomId = $state<string | undefined>();
	let drafts = $state<Record<string, string>>({});
	let replyDrafts = $state<Record<string, string | undefined>>({});
	let replyId = $state<string | undefined>();
	let pendingOpen = $state<PendingOpen | undefined>();
	/** A room or thread joined from the directory, opened once its `room_update` has arrived. */
	let pendingJoin = $state<string | undefined>();
	/**
	 * Where the New divider sits in the open pane: after your read cursor as it
	 * was when the pane opened (§4.4). It stays put while you read.
	 */
	let newDivider = $state<{ room: string; after?: string; fixed: boolean }>({ room: '', fixed: false });
	/** Messages a thread is being started from, for the button's "Starting…". */
	let startingThreads = $state<Record<string, true>>({});
	let mobilePane = $state<'rooms' | 'main'>('main');
	let composer = $state<Composer | undefined>();
	let messageScroll = $state<HTMLDivElement | undefined>();
	let stickToBottom = $state(true);
	let latestVisible = $state(true);
	let seenCount = $state(0);
	let typingTimer: ReturnType<typeof setTimeout> | undefined;
	/** Where the last scroll event, or automatic scroll to the latest item, left the list. */
	let lastScrollTop: number | undefined;
	let highlightTimer: ReturnType<typeof setTimeout> | undefined;
	/** Oldest timeline items not rendered yet (see FIRST_PAINT_ITEMS). */
	let hiddenItems = $state(0);
	let revealFrame = 0;
	let revealTimer: ReturnType<typeof setTimeout> | undefined;

	let snapshot = $derived(session.snapshot);
	/** The top-level room open in the pane (or behind the open thread). */
	let activeRoom = $derived(session.activeRoom);
	/** The active room's threads: the joined ones, then those listed as not joined, which get cards too. */
	let threads = $derived(threadEntries(session.rooms, activeRoom?.id, activeRoom ? snapshot.threadDirectory[activeRoom.id] : undefined, resolveMessage));
	let joinedThreads = $derived(threads.filter((entry) => entry.joined));
	/** The sidebar lists joined threads, and a thread open without joining while it is open. */
	let listedThreads = $derived(threads.filter((entry) => entry.joined || entry.id === activeThread));
	/** The open thread, joined or read without joining; the client holds either as a room. */
	let activeThreadEntry = $derived(activeThread && session.rooms.some((room) => room.id === activeThread) ? threads.find((entry) => entry.id === activeThread) : undefined);
	let threadRoom = $derived(activeThreadEntry ? session.rooms.find((room) => room.id === activeThreadEntry.id) : undefined);
	/** The room the pane shows and the composer posts to: the open thread (itself a room), else the room. */
	let paneRoom = $derived(activeThread ? threadRoom : activeRoom);
	let messages = $derived(timelineMessages(paneRoom));
	let intro = $derived(activeThread ? activeThreadEntry?.introMessage : undefined);
	let timeline = $derived(activeThread
		? buildThreadTimeline({ messages, intro, renames: paneRoom?.renames, moreReplies: Boolean(threadRoom?.olderAvailable), notices: paneRoom?.notices })
		: buildRoomTimeline({ messages, threads, notices: paneRoom?.notices }));
	let shownTimeline = $derived(hiddenItems > 0 ? timeline.slice(Math.min(hiddenItems, timeline.length)) : timeline);
	let canCompose = $derived(Boolean(paneRoom && session.ready && !snapshot.authBusy));
	let people = $derived(peopleIn([...(activeThread ? timelineMessages(activeRoom) : []), ...(intro ? [intro] : []), ...messages], session.you, paneRoom?.members));
	let typingNames = $derived(snapshot.typing
		.filter((entry) => entry.room === paneRoom?.id && entry.from.user_id !== session.you?.user_id)
		.map((entry) => directory.name(entry.from)));
	/** The first message after your read cursor, unless you wrote it: the New divider goes above it. */
	let newDividerBefore = $derived.by(() => {
		if (newDivider.room !== paneRoom?.id || newDivider.after === undefined) return undefined;
		const after = newDivider.after;
		// The first message row after the cursor; thread intros show as cards and carry no row.
		for (const item of timeline) {
			if (item.kind !== 'message' || compareLogIds(item.event.message_id, after) <= 0) continue;
			return isOwn(item.event, session.you) ? undefined : item.event.message_id;
		}
		return undefined;
	});
	let backendLabel = $derived(session.server?.name || backendHost(serverInput) || 'Apron');
	let threadReplyCount = $derived(threadRoom?.loaded ? messages.filter((event) => event.message_id !== intro?.message_id).length : undefined);
	let unseenCount = $derived(stickToBottom ? 0 : Math.max(0, messages.length - seenCount));
	let demoNotice = $derived(demoRetentionNotice(session.server));
	/** The pane's messages this viewer may pick, in order: what shift-click ranges run along. */
	let selectableOrder = $derived(messages.filter(canSelect).map((event) => event.message_id));
	let selectThreads = $derived(joinedThreads.filter((entry) => entry.id !== activeThread));
	/** New threads hang off a top-level room; this client keeps threads one level deep. */
	let canStartThreads = $derived(session.canManageRooms && Boolean(activeRoom) && activeRoom?.parentRoomId === undefined);

	$effect(() => {
		const roomId = activeRoom?.id;
		if (roomId !== undefined && selectedRoomId !== roomId) setDestination(roomId, undefined);
	});

	$effect(() => {
		mentions.observe(session.rooms, session.you, paneRoom?.id, latestVisible);
	});

	$effect(() => {
		unread.observe(session.rooms, session.you, paneRoom?.id, latestVisible && pageVisible);
	});

	// Nobody is attending a hidden or unfocused tab (§4.4): the server may push instead.
	$effect(() => {
		const away = !(pageVisible && pageFocused);
		if (client && session.ready) untrack(() => client?.setAway(away));
	});

	// Each mention that lands while you're in another window or tab chimes once and flags the tab.
	$effect(() => {
		const arrived = mentions.arrived;
		if (arrived === alertedMentions) return;
		alertedMentions = arrived;
		if (untrack(() => pageFocused && pageVisible)) return;
		attention = true;
		playPing();
	});

	$effect(() => {
		if (!attention) {
			titleFlash = false;
			return;
		}
		titleFlash = true;
		const timer = setInterval(() => (titleFlash = !titleFlash), 1000);
		return () => clearInterval(timer);
	});

	// The New divider is placed once per visit, from the read cursor the server kept.
	$effect(() => {
		const room = paneRoom;
		if (!room) return;
		if (newDivider.room !== room.id) newDivider = { room: room.id, fixed: false };
		else if (!newDivider.fixed && room.loaded) newDivider = { room: room.id, after: room.readMessageId, fixed: true };
	});

	// Reading the latest message advances your read cursor (cap `activity`); the server syncs it to your other devices.
	$effect(() => {
		const room = paneRoom;
		const last = messages[messages.length - 1];
		// Only once this pane's divider is in place: advancing first would hide what was new.
		if (!client || !room || !last || !latestVisible || !pageVisible || !room.loaded || !session.ready || newDivider.room !== room.id || !newDivider.fixed) return;
		untrack(() => client?.markRead(room.id, last.message_id));
	});

	// Members for the mention picker come with each joined room's listing and stay current by
	// memberships (§4.3.2); a pane without them (a thread read without joining) lists its room
	// with `room_list` and `room_id` (cap `rooms`).
	$effect(() => {
		const room = paneRoom;
		if (!client || !room || !session.ready || !session.canManageRooms || room.members !== undefined) return;
		untrack(() => listMembers(MEMBERS_RETRY_MS));
	});

	// A room joined from the directory opens once its `room_update` has arrived.
	$effect(() => {
		const joined = pendingJoin;
		const room = joined ? session.rooms.find((candidate) => candidate.id === joined) : undefined;
		if (!room) return;
		pendingJoin = undefined;
		untrack(() => {
			if (room.parentRoomId !== undefined && session.rooms.some((candidate) => candidate.id === room.parentRoomId)) openDestination(room.parentRoomId, room.id);
			else chooseRoom(room);
		});
	});

	// Leaving a pane ends its selection in setDestination; losing the cap ends it here.
	$effect(() => {
		if (!session.canEdit) selection.cancel();
	});

	// A thread this viewer just created opens once its `room_update` has arrived.
	$effect(() => {
		const pending = pendingOpen;
		if (!pending || !session.rooms.some((room) => room.id === pending.thread)) return;
		pendingOpen = undefined;
		untrack(() => openDestination(pending.room, pending.thread));
	});

	// A thread's first page may not fill the pane, leaving nothing to scroll back
	// with: load older replies until it does or there are none.
	$effect(() => {
		const room = threadRoom;
		void timeline.length;
		if (!room?.loaded || !room.olderAvailable || room.loadingOlder || !messageScroll) return;
		untrack(() => {
			tick().then(() => {
				if (messageScroll && messageScroll.scrollHeight <= messageScroll.clientHeight + OLDER_REPLIES_MARGIN_PX) void loadOlderReplies();
			});
		});
	});

	// A thread opens at its intro, unless only its newest replies are loaded: then it
	// opens at those, like a room, and reading back loads the older ones.
	$effect(() => {
		const room = threadRoom;
		if (!openingThread || !room?.loaded) return;
		if (room.id !== openingThread) {
			openingThread = undefined;
			return;
		}
		openingThread = undefined;
		if (!room.olderAvailable) return;
		stickToBottom = true;
		untrack(() => requestAnimationFrame(() => { if (stickToBottom) scrollToLatest(); }));
	});

	// Threads don't recover with their parent: the open one loads its own history,
	// again after a reconnect, which lists it afresh.
	$effect(() => {
		const room = threadRoom;
		if (!client || !room || !session.ready || room.loaded || room.loading || room.recoveryError) return;
		untrack(() => loadThread(room.id));
	});

	$effect(() => {
		if (editingId && !timeline.some((item) => item.kind === 'message' && item.event.message_id === editingId && !item.event.deleted)) {
			editingId = undefined;
		}
	});

	$effect(() => {
		messages.length;
		paneRoom?.id;
		if (!stickToBottom || !messageScroll) return;
		requestAnimationFrame(() => {
			if (stickToBottom) scrollToLatest();
		});
	});

	// Stay pinned to the latest item while the pane fills in: a room's history, its threads'
	// cards and intros land over several updates, not all of which change what the effect
	// above tracks. Follow the rendered content instead.
	$effect(() => {
		const scroll = messageScroll;
		if (!scroll) return;
		let frame = 0;
		const observer = new MutationObserver(() => {
			if (!stickToBottom || frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (stickToBottom) scrollToLatest();
			});
		});
		observer.observe(scroll, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
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
		const unsubscribe = chat.subscribe((next) => {
			session.apply(next, chat);
			directory.apply(next, serverOrigin(chat.url));
		});
		chat.start();
		client = chat;
		return () => {
			if (typingTimer) clearTimeout(typingTimer);
			if (highlightTimer) clearTimeout(highlightTimer);
			stopRevealing();
			if (floatingDayTimer) clearTimeout(floatingDayTimer);
			feedback.dispose();
			mentions.dispose();
			session.dispose();
			unsubscribe();
			chat.stop();
		};
	});

	// --- Connecting ---

	/** The profile's "Sign in with a passkey" opens here too, carrying the handle typed there. */
	function openConnect(options: { passkey?: boolean; name?: string } = {}): void {
		connectScheme = options.passkey ? 'webauthn' : undefined;
		if (options.name) displayName = options.name;
		connectOpen = true;
	}

	/** Asks `room_list` for the pane's members, unless a listing was answered within `maxAge`. */
	function listMembers(maxAge: number): void {
		const room = paneRoom;
		if (!client || !room || !session.ready || !session.canManageRooms) return;
		client.listMembers(room.id, maxAge).catch(() => undefined);
	}

	/** The connect form was submitted: whatever belonged to the previous backend goes. */
	function leaveBackend(): void {
		saveCurrentDraft();
		selectedRoomId = undefined;
		activeThread = undefined;
		pendingOpen = undefined;
		startingThreads = {};
		composerText = '';
		replyId = undefined;
		threadEditorOpen = false;
		selection.cancel();
		session.forget();
		directory.forget();
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

	/** Drafts are kept per room, and a thread is a room of its own. */
	function draftKey(roomId: string): string {
		return JSON.stringify([client?.url ?? serverInput, roomId]);
	}

	/** The room the composer's draft belongs to: the open thread, else the room. */
	function paneKey(): string | undefined {
		return selectedRoomId !== undefined ? draftKey(activeThread ?? selectedRoomId) : undefined;
	}

	function saveCurrentDraft(): void {
		const key = paneKey();
		if (!key) return;
		drafts = { ...drafts, [key]: composerText };
		replyDrafts = { ...replyDrafts, [key]: replyId };
	}

	/** Moves the pane to a room or one of its threads, keeping each destination's draft and reply. */
	function setDestination(roomId: string, thread: string | undefined): void {
		if (selectedRoomId === roomId && activeThread === thread) return;
		saveCurrentDraft();
		selectedRoomId = roomId;
		activeThread = thread;
		const key = draftKey(thread ?? roomId);
		composerText = drafts[key] ?? '';
		replyId = replyDrafts[key];
		editingId = undefined;
		threadEditorOpen = false;
		selection.cancel();
		composer?.reset();
		mentions.clearUnseen();
		mentions.clearRoom(roomId);
		if (thread) mentions.clearRoom(thread);
		stickToBottom = true;
		// A thread opens at its intro, at the top, so it renders whole.
		revealFrom(thread ? 0 : timeline.length - FIRST_PAINT_ITEMS);
	}

	/** Renders the timeline from `hidden` items in, then reveals the older ones after each paint. */
	function revealFrom(hidden: number): void {
		stopRevealing();
		hiddenItems = Math.max(0, hidden);
		if (hiddenItems > 0) scheduleReveal();
	}

	function scheduleReveal(): void {
		revealFrame = requestAnimationFrame(() => {
			revealFrame = 0;
			revealTimer = setTimeout(revealChunk, 0);
		});
	}

	async function revealChunk(): Promise<void> {
		revealTimer = undefined;
		const scroller = messageScroll;
		const height = scroller?.scrollHeight ?? 0;
		const top = scroller?.scrollTop ?? 0;
		hiddenItems = Math.max(0, hiddenItems - REVEAL_CHUNK_ITEMS);
		if (hiddenItems > 0) scheduleReveal();
		await tick();
		// Older items land above: keep the reader's place unless the pane follows the latest.
		if (!scroller || messageScroll !== scroller || stickToBottom) return;
		scroller.scrollTop = top + (scroller.scrollHeight - height);
		lastScrollTop = scroller.scrollTop;
	}

	function stopRevealing(): void {
		if (revealFrame) cancelAnimationFrame(revealFrame);
		if (revealTimer) clearTimeout(revealTimer);
		revealFrame = 0;
		revealTimer = undefined;
	}

	/** Opens a room, or a thread under it, switching the top-level room first when it differs. */
	function openDestination(roomId: string, thread: string | undefined): void {
		if (!client) return;
		if (activeRoom?.id !== roomId) session.chooseRoom(client, roomId);
		setDestination(roomId, thread);
		mobilePane = 'main';
	}

	function chooseThread(thread: string): void {
		if (!activeRoom) return;
		setDestination(activeRoom.id, thread);
		stickToBottom = false;
		seenCount = messages.length;
		openingThread = thread;
		requestAnimationFrame(() => { if (messageScroll) messageScroll.scrollTop = 0; });
		// A failed load stays failed until the thread is opened again.
		if (session.rooms.find((room) => room.id === thread)?.recoveryError) loadThread(thread);
		mobilePane = 'main';
		composer?.focus();
	}

	/**
	 * A thread card opens its thread. One you haven't joined is read through
	 * its history without joining it (joining logs a membership for everyone,
	 * §4.3.2); replying or Join makes it live.
	 */
	function openThreadCard(thread: string): void {
		if (!client) return;
		if (!session.rooms.some((room) => room.id === thread) && !client.viewRoom(thread)) {
			joinRoom(thread);
			return;
		}
		chooseThread(thread);
	}

	/** Loads a thread's history (§4.1); a failure the client recorded is reported once. */
	function loadThread(roomId: string): void {
		client?.loadRoom(roomId).catch((cause: unknown) => {
			if (session.rooms.find((room) => room.id === roomId)?.recoveryError) feedback.error(cause, 'Unable to load thread');
		});
	}

	function backToRoom(): void {
		if (!activeRoom) return;
		setDestination(activeRoom.id, undefined);
		composer?.focus();
	}

	function threadTitle(thread: string): string {
		return threads.find((entry) => entry.id === thread)?.title ?? thread;
	}

	// --- Composing ---

	function composerInput(): void {
		if (!client || !paneRoom) return;
		const key = paneKey();
		if (key) drafts = { ...drafts, [key]: composerText };
		const roomId = paneRoom.id;
		client.sendTyping(roomId, true);
		if (typingTimer) clearTimeout(typingTimer);
		typingTimer = setTimeout(() => client?.sendTyping(roomId, false), 5000);
	}

	/**
	 * Sends the composer's text: a message with the draft's mentions (§3.5), or
	 * with cap `command` a command (§4.8), which `/nick`, `/join`, `/leave` and
	 * `/topic` turn into the requests they spell. A command's failure shows as
	 * a local notice in the pane, where its replies land too.
	 */
	function sendMessage(): void {
		if (!client || !paneRoom || !canCompose || !composerText.trim()) return;
		const chat = client;
		const draft = composerText;
		const roomId = paneRoom.id;
		const reply = replyId;
		const originKey = draftKey(roomId);
		const mentions = composerMentions;
		const action = composerAction(draft, { command: snapshot.capabilities.command, rooms: session.canManageRooms });
		const restore = () => {
			// A failed send gives the draft back, unless something else has been typed since.
			const currentKey = paneKey();
			if (!drafts[originKey] && !replyDrafts[originKey] && !(currentKey === originKey && (composerText || replyId))) {
				drafts = { ...drafts, [originKey]: draft };
				replyDrafts = { ...replyDrafts, [originKey]: reply };
			}
			if (currentKey === originKey && !composerText && !replyId) {
				composerText = drafts[originKey];
				replyId = replyDrafts[originKey];
				composer?.focus();
			}
		};
		const options = { ...(reply ? { replyTo: reply } : {}), ...(mentions.length ? { mentions } : {}) };
		if (action.kind === 'message') {
			if (!action.text.trim()) return;
			const post = () => feedback.track(chat.send(roomId, action.text, 'markdown', options), 'Sending…', restore);
			const joining = joinFirst(chat, paneRoom);
			if (joining) {
				joining.then(post, (cause: unknown) => {
					feedback.error(cause, 'Unable to join the thread');
					restore();
				});
			} else {
				post();
			}
			stickToBottom = true;
		} else {
			const failed = (cause: unknown) => {
				chat.notify(roomId, cause instanceof Error && cause.message ? cause.message : 'The command failed');
				restore();
			};
			if (action.kind === 'command') {
				chat.command(roomId, draft, options).promise.catch(failed);
			} else if (action.kind === 'nick') {
				displayName = action.name;
				saveDisplayName(action.name);
				chat.setDisplayName(action.name)?.promise.catch(failed);
			} else if (action.kind === 'join') {
				joinByName(action.room, failed);
			} else if (action.kind === 'leave') {
				const leaving = action.room ?? roomId;
				if (leaving === roomId && activeThread && activeRoom) backToRoom();
				chat.leaveRoom(leaving).promise.catch(failed);
			} else {
				chat.updateRoom(roomId, { title: action.title }).promise.catch(failed);
			}
		}
		clearComposer(roomId);
		chat.sendTyping(roomId, false);
		if (typingTimer) clearTimeout(typingTimer);
		composer?.focus();
	}

	/** `/join`: a room you're in opens; another, found by ID or title among those listed, is joined and opens once it arrives. */
	function joinByName(name: string, failed: (cause: unknown) => void): void {
		if (!client) return;
		const wanted = name.toLowerCase();
		const joined = session.rooms.find((room) => room.id === name) ?? session.rooms.find((room) => room.title.toLowerCase() === wanted);
		if (joined) {
			openMentionedRoom(joined.id);
			return;
		}
		const listed = [...(snapshot.directory ?? []), ...Object.values(snapshot.threadDirectory).flat()];
		const target = listed.find((listing) => listing.id === name) ?? listed.find((listing) => listing.title.toLowerCase() === wanted);
		pendingJoin = target?.id ?? name;
		client.joinRoom(pendingJoin).promise.catch(failed);
	}

	/**
	 * Sends picked files (cap `embed:upload`) as upload embeds, with whatever
	 * is in the composer as the text; each file is written to the URL the
	 * server hands back, and the message shows it pending until then. A command
	 * takes them as arguments instead (§4.8).
	 */
	function sendFiles(files: File[]): void {
		if (!client || !paneRoom || !canCompose || !session.snapshot.capabilities['embed:upload']) return;
		const chat = client;
		const roomId = paneRoom.id;
		const reply = replyId;
		const action = composerAction(composerText, { command: snapshot.capabilities.command, rooms: false });
		const command = action.kind === 'command';
		const text = action.kind === 'message' ? action.text : composerText;
		const mentions = composerMentions;
		const options = { ...(reply ? { replyTo: reply } : {}), ...(mentions.length ? { mentions } : {}) };
		const joining = command ? undefined : joinFirst(chat, paneRoom);
		const { sent, uploaded } = joining
			? (() => {
				const posted = joining.then(() => chat.sendFiles(roomId, text, files, 'markdown', options, command));
				return { sent: posted.then(({ sent }) => sent), uploaded: posted.then(({ uploaded }) => uploaded) };
			})()
			: chat.sendFiles(roomId, text, files, 'markdown', options, command);
		feedback.pending(files.length === 1 ? `Uploading ${files[0].name || 'file'}…` : `Uploading ${files.length} files…`);
		sent.then(() => {
			clearComposer(roomId);
		}, (cause: unknown) => {
			if (!command) {
				feedback.error(cause, 'Unable to send the attachment');
				return;
			}
			feedback.clear();
			chat.notify(roomId, cause instanceof Error && cause.message ? cause.message : 'The command failed');
		});
		uploaded.then(() => feedback.clear(), (cause: unknown) => {
			if (!command) feedback.error(cause, 'Upload failed');
		});
		stickToBottom = true;
		composer?.focus();
	}

	// --- Rooms ---

	function joinRoom(roomId: string): void {
		if (!client) return;
		pendingJoin = roomId;
		feedback.track(client.joinRoom(roomId), 'Joining…');
	}

	/** Leaves the open room or thread (cap `rooms`); the server removes it from the list. */
	function leavePane(): void {
		if (!client || !paneRoom) return;
		const leaving = paneRoom;
		if (!confirm(`Leave ${leaving.title}? You can join it again from Browse rooms.`)) return;
		if (activeThread && activeRoom) backToRoom();
		feedback.track(client.leaveRoom(leaving.id), 'Leaving…');
	}

	/** Joins the thread open without joining (cap `rooms`): from then on it delivers live. */
	function joinPane(): void {
		if (!client || !paneRoom || paneRoom.joined) return;
		feedback.track(client.joinRoom(paneRoom.id), 'Joining…');
	}

	/**
	 * Posting needs no membership (§4.3.5), but a poster who hasn't joined
	 * doesn't receive the broadcast: a reply in a thread read without joining
	 * joins it first, so the reply and what follows arrive.
	 */
	function joinFirst(chat: ChatClient, room: RoomSnapshot): Promise<unknown> | undefined {
		if (room.joined || !session.canManageRooms) return undefined;
		return chat.joinRoom(room.id).promise;
	}

	/** A room mention in a message was clicked: open it, or join it when you haven't. */
	function openMentionedRoom(roomId: string): void {
		const room = session.rooms.find((candidate) => candidate.id === roomId);
		if (!room) {
			if (session.canManageRooms) joinRoom(roomId);
			return;
		}
		if (room.parentRoomId !== undefined && session.rooms.some((candidate) => candidate.id === room.parentRoomId)) openDestination(room.parentRoomId, room.id);
		else chooseRoom(room);
	}

	function clearComposer(roomId: string): void {
		const key = draftKey(roomId);
		composerText = '';
		replyId = undefined;
		drafts = { ...drafts, [key]: '' };
		replyDrafts = { ...replyDrafts, [key]: undefined };
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

	/**
	 * A message by ID in any room: a reply target (`reply_to` may cross rooms)
	 * or a thread's intro. Visible rooms' timelines first, so this follows
	 * every snapshot; then anything else the client has stored.
	 */
	function resolveMessage(id: string): MessageRecord | undefined {
		return findMessage(session.rooms, id) ?? client?.message(id);
	}

	function replyPreview(id: string): string {
		const target = resolveMessage(id);
		if (!target) return 'Message unavailable';
		if (target.deleted) return 'Message deleted';
		return `${senderName(target)}: ${replySnippet(target)}`;
	}

	/** A message's reaction chips, from the timeline of the room it lives in (an intro may live in the parent). */
	function reactionsFor(event: MessageRecord): ReactionChip[] {
		const room = session.rooms.find((candidate) => candidate.id === event.room_id);
		return reactionChips(room?.timeline.reactions[event.message_id], session.you?.user_id, event.deleted === true, (user) => directory.name(user));
	}

	function react(event: MessageRecord, emoji: string): void {
		if (!client || !session.canReact || event.deleted) return;
		feedback.track(client.toggleReaction(event.message_id, emoji), 'Reacting…');
	}

	// --- Reading ---

	/**
	 * Where a message shows: a thread's messages in the thread; a room's own
	 * message in the room, unless it introduces one of the room's threads,
	 * which is pinned at the top of that thread instead.
	 */
	function destinationOf(target: MessageRecord): { room: string; thread?: string } | undefined {
		const rooms = session.rooms;
		const home = rooms.find((room) => room.id === target.room_id);
		if (!home) return undefined;
		if (home.parentRoomId !== undefined && rooms.some((room) => room.id === home.parentRoomId)) return { room: home.parentRoomId, thread: home.id };
		if (activeThread && activeRoom?.id === home.id && activeThreadEntry?.introMessageId === target.message_id) return { room: home.id, thread: activeThread };
		const introduced = childRooms(rooms, home.id).find((room) => room.introMessageId === target.message_id);
		return introduced ? { room: home.id, thread: introduced.id } : { room: home.id };
	}

	async function renderedMessage(id: string): Promise<HTMLElement | undefined> {
		const started = performance.now();
		await tick();
		for (;;) {
			const node = messageScroll?.querySelector<HTMLElement>(`article[data-message-id="${CSS.escape(id)}"]`);
			if (node || performance.now() - started > JUMP_WAIT_MS) return node ?? undefined;
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
	}

	/**
	 * Scrolls the timeline to a message and highlights it for a moment, first
	 * opening the room or thread it lives in (and loading a thread's history).
	 */
	async function jumpToMessage(id: string): Promise<void> {
		const target = resolveMessage(id);
		const destination = target ? destinationOf(target) : undefined;
		if (!destination) return;
		if (destination.room !== activeRoom?.id || destination.thread !== activeThread) {
			openDestination(destination.room, destination.thread);
			stickToBottom = false;
		}
		revealFrom(0);
		const node = await renderedMessage(id);
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
		scrollToLatest();
	}

	function scrollToLatest(): void {
		if (!messageScroll) return;
		messageScroll.scrollTop = messageScroll.scrollHeight;
		lastScrollTop = messageScroll.scrollTop;
	}

	/** Takes you to the oldest mention that arrived while you were reading back. */
	function jumpToMention(): void {
		const target = mentions.takeUnseen();
		if (target) void jumpToMessage(target);
		else jumpToLatest();
	}

	function trackScroll(): void {
		if (!messageScroll) return;
		const top = messageScroll.scrollTop;
		const scrolledUp = lastScrollTop === undefined || top < lastScrollTop - 1;
		lastScrollTop = top;
		// While pinned, only the reader scrolling up lets go. The pane grows under us as a room's
		// history, its threads' cards and long messages lay out; our own scroll's event can land
		// after that, and scroll anchoring moves the list down, before the next frame catches up.
		if (stickToBottom && !scrolledUp) {
			requestAnimationFrame(() => {
				if (stickToBottom) scrollToLatest();
			});
			return;
		}
		const atBottom = messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight < 96;
		if (top < OLDER_REPLIES_MARGIN_PX) void loadOlderReplies();
		if (!atBottom && stickToBottom) seenCount = messages.length;
		stickToBottom = atBottom;
		floatDay(atBottom);
	}

	/**
	 * A thread opens on its newest replies; reading back near the top loads the
	 * page before them. The reader's place is kept: whatever was on screen stays
	 * put while the older replies land above it.
	 */
	async function loadOlderReplies(): Promise<void> {
		const room = threadRoom;
		if (!client || !room || !messageScroll || !room.olderAvailable || room.loadingOlder) return;
		const scroller = messageScroll;
		const height = scroller.scrollHeight;
		const top = scroller.scrollTop;
		try {
			await client.loadOlder(room.id);
		} catch {
			return; // The next scroll back tries again.
		}
		await tick();
		if (messageScroll !== scroller || stickToBottom) return;
		// Where the browser anchored the view itself this is already the position.
		scroller.scrollTop = top + (scroller.scrollHeight - height);
		lastScrollTop = scroller.scrollTop;
	}

	/** While you scroll back, the day you're reading floats at the top; it fades once you stop. */
	function floatDay(atBottom: boolean): void {
		if (floatingDayTimer) clearTimeout(floatingDayTimer);
		if (!messageScroll || atBottom) {
			floatingDayShown = false;
			return;
		}
		// The first message still showing below the top edge; rows are in order, so bisect.
		const top = messageScroll.getBoundingClientRect().top;
		const rows = messageScroll.querySelectorAll<HTMLElement>('article[data-message-id]');
		let low = 0;
		let high = rows.length - 1;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
			else high = middle;
		}
		const label = rows.length ? dayLabelOf(rows[low].dataset.messageId ?? '') : '';
		floatingDay = label;
		floatingDayShown = Boolean(label);
		floatingDayTimer = setTimeout(() => (floatingDayShown = false), 1200);
	}

	// --- Editing ---

	/** Your own messages in the open pane can be picked for a move (cap `edit`); a thread's intro from another room can't. */
	function canSelect(event: MessageRecord): boolean {
		return session.canEdit && isOwn(event, session.you) && !event.deleted && event.room_id === paneRoom?.id;
	}

	/** What the toolbar offers: only what the server can do, and only on messages this viewer may change. */
	function capsFor(event: MessageRecord): MessageCaps {
		const own = session.canEdit && isOwn(event, session.you);
		return {
			reply: canCompose && !event.deleted,
			edit: own && !event.deleted,
			startThread: canStartThreads && canCompose && !event.deleted && !activeThread && event.room_id === activeRoom?.id,
			select: canSelect(event),
			removeReply: own && Boolean(event.reply_to),
			react: session.canReact && canCompose && !event.deleted
		};
	}

	function saveEdit(event: MessageRecord, text: string): void {
		if (!client || !session.canEdit) return;
		feedback.track(client.editMessage(event.message_id, text), 'Saving edit…');
		editingId = undefined;
	}

	function deleteMessage(event: MessageRecord): void {
		if (!client || !session.canEdit) return;
		if (!confirm('Delete this message? This cannot be undone.')) return;
		feedback.track(client.deleteMessage(event.message_id), 'Deleting message…');
	}

	function removeReply(event: MessageRecord): void {
		if (!client || !session.canEdit) return;
		feedback.track(client.setMessageReply(event.message_id, null), 'Removing reply reference…');
	}

	/**
	 * Starts a thread on a message (cap `rooms`): a room under this one whose
	 * intro is the message, which stays where it is. The thread opens once the
	 * `room_update` has arrived.
	 */
	async function startThread(event: MessageRecord): Promise<void> {
		if (!client || !activeRoom || !canStartThreads || event.deleted || startingThreads[event.message_id]) return;
		const chat = client;
		const roomId = activeRoom.id;
		const id = event.message_id;
		startingThreads = { ...startingThreads, [id]: true };
		feedback.pending('Starting thread…');
		try {
			const result = await chat.createRoom({ parentRoomId: roomId, title: threadTitleFor(event), introMessageId: id }).promise;
			if (typeof result.room_id !== 'string') throw new Error('Invalid room response');
			pendingOpen = { room: roomId, thread: result.room_id };
			feedback.clear();
		} catch (cause) {
			feedback.error(cause, 'Unable to start thread');
		} finally {
			const next = { ...startingThreads };
			delete next[id];
			startingThreads = next;
		}
	}

	// --- Select mode ---

	function beginSelect(event: MessageRecord): void {
		if (!paneRoom || !canSelect(event)) return;
		editingId = undefined;
		composer?.reset();
		selection.begin(paneRoom.id, event.message_id);
	}

	/**
	 * Moves the selection to a thread or back to the room (cap `edit`), or into
	 * a new thread (cap `rooms`), which opens once it exists. An existing
	 * destination leaves the pane as it is.
	 */
	async function moveSelection(target: string | 'new'): Promise<void> {
		if (!client || !activeRoom || !paneRoom || !session.canEdit) return;
		const roomId = activeRoom.id;
		const result = target === 'new'
			? await selection.moveToNewThread(client, messages.map((event) => event.message_id), {
				parentRoomId: roomId,
				title: (introId) => threadTitleFor(resolveMessage(introId))
			})
			: await selection.move(client, target);
		if (!result.moved) {
			if (result.error !== undefined) feedback.error(result.error, 'Some messages could not be moved');
			return;
		}
		if (target === 'new') pendingOpen = { room: roomId, thread: result.room };
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

<svelte:window onkeydown={windowKeydown} onfocus={() => { pageFocused = true; attention = false; }} onblur={() => (pageFocused = false)} />
<svelte:document onvisibilitychange={() => {
	pageVisible = document.visibilityState === 'visible';
	pageFocused = document.hasFocus();
	if (pageVisible && pageFocused) attention = false;
}} />

<svelte:head>
	<title>{tabTitle(unread.total, titleFlash)}</title>
	<meta name="description" content="Apron, a chat frontend for the Bottomless Chat protocol." />
</svelte:head>

{#if !client}
	<div class="app ap-shell ap-shell-norail"></div>
{:else if connectOpen}
	<ConnectScreen
		{client} {session} bind:serverInput bind:displayName {passkeyUnavailable} {recentServers}
		canCancel={session.rooms.length > 0 || session.ready} initialScheme={connectScheme}
		onconnect={leaveBackend} onconnected={connected} oncancel={() => (connectOpen = false)} onsignout={() => session.forget()}
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
		{client} {session} {backendLabel} threads={listedThreads} {activeThread} mentions={mentions.byRoom} bind:displayName {passkeyUnavailable}
		onconnect={() => openConnect()} onsignin={(name) => openConnect({ passkey: true, name })}
		onroom={chooseRoom} onthread={chooseThread} onjoin={joinRoom} onsignout={() => session.forget()}
	/>
	<SidebarHandle layout={sidebar} />

	<main class="ap-shell-main" aria-label="Conversation">
		{#if activeRoom}
			<RoomHeader
				room={activeRoom}
				pane={paneRoom ?? activeRoom}
				threadTitle={activeThread ? threadTitle(activeThread) : undefined}
				typing={typingNames}
				replyCount={activeThread ? threadReplyCount : undefined}
				moreReplies={Boolean(activeThread && threadRoom?.olderAvailable)}
				canEditThread={Boolean(activeThread && session.canManageRooms && activeThreadEntry)}
				editorOpen={threadEditorOpen}
				editDisabled={!canCompose}
				canLeave={session.canLeaveRooms && Boolean(paneRoom?.joined)}
				canJoin={session.canManageRooms && Boolean(paneRoom) && !paneRoom?.joined}
				onback={() => (mobilePane = 'rooms')} onroom={backToRoom} onedit={() => (threadEditorOpen = !threadEditorOpen)} onleave={leavePane} onjoin={joinPane}
			/>
			{#if threadEditorOpen && activeThreadEntry}
				{#key activeThreadEntry.id}
					<ThreadEditor {client} thread={activeThreadEntry} enabled={canCompose && session.canManageRooms} onclose={() => (threadEditorOpen = false)} />
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
								<button class="ap-btn ap-btn-sm" type="button" data-testid="reconnect-retry" disabled={Boolean(snapshot.retryAfterMs)} onclick={() => client && session.retryNow(client)}>{snapshot.held ? 'Sign in' : 'Try Again'}</button>
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

			<div class="ap-timeline" bind:this={messageScroll} onscroll={trackScroll} data-testid="message-list" role="log" aria-live="polite" aria-label={`${activeThread ? threadTitle(activeThread) : activeRoom.title} messages`}>
				<div class="day-float" class:day-float-shown={floatingDayShown} aria-hidden="true" data-testid="floating-day"><span>{floatingDay}</span></div>
				{#if snapshot.showReconnectDivider}
					<div class="ap-divider ap-divider-gap" role="separator" data-testid="reconnect-divider"><span>Reconnected · earlier messages aren’t available</span></div>
				{/if}
				{#if timeline.length === 0 && !(paneRoom?.recovering || paneRoom?.loading)}
					<div class="empty">
						<h2>{activeThread ? 'No replies yet' : 'Nothing here yet'}</h2>
						<p>{activeThread ? 'Reply below to continue the thread.' : `Start the conversation in ${activeRoom.title}.`}</p>
					</div>
				{:else}
					{#each shownTimeline as item (item.key)}
						{#if item.kind === 'date'}
							<div class="ap-divider ap-divider-date" role="separator"><span>{item.label}</span></div>
						{:else if item.kind === 'replies'}
							<div class="ap-divider ap-divider-date" role="separator"><span>{item.count}{item.more ? '+' : ''} {item.count === 1 && !item.more ? 'reply' : 'replies'}</span></div>
						{:else if item.kind === 'thread'}
							<ThreadCard entry={item.entry} onopen={() => openThreadCard(item.entry.id)} />
						{:else if item.kind === 'notice'}
							<NoticeLine notice={item.notice} onopenroom={openMentionedRoom} />
						{:else if item.kind === 'renamed'}
							<div data-timeline-item class="ap-msg ap-msg-system" data-testid="thread-renamed">
								<div class="ap-msg-system-body">{#if item.title}Thread renamed to <span class="ap-msg-text">“{item.title}”</span>{:else}Thread name cleared{/if}</div>
								{#if idTime(item.logId)}<time class="ap-msg-system-time" datetime={idIso(item.logId)} title={idDateTime(item.logId)}>{idTime(item.logId)}</time>{/if}
							</div>
						{:else}
							{@const event = item.event}
							{#if event.message_id === newDividerBefore}
								<div class="ap-divider ap-divider-new" role="separator" data-testid="new-divider"><span>New</span></div>
							{/if}
							<Message
								{event}
								grouped={item.grouped}
								resolve={resolveMessage}
								reactions={reactionsFor(event)}
								uploads={snapshot.uploads}
								mention={mentionsMe(event, session.you)}
								pinged={mentions.pinged.includes(event.message_id)}
								highlighted={highlightedId === event.message_id}
								selecting={selection.active}
								selected={selection.has(event.message_id)}
								editing={editingId === event.message_id}
								startingThread={Boolean(startingThreads[event.message_id])}
								caps={capsFor(event)}
								onreply={() => beginReply(event)}
								onjump={jumpToMessage}
								onopenroom={openMentionedRoom}
								onedit={() => (editingId = event.message_id)}
								onsave={(text) => saveEdit(event, text)}
								oncanceledit={() => (editingId = undefined)}
								ondelete={() => deleteMessage(event)}
								onremovereply={() => removeReply(event)}
								onstartthread={() => startThread(event)}
								onreact={(emoji) => react(event, emoji)}
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
					{selection} threads={selectThreads} parentRoom={activeThread ? activeRoom.id : undefined} canCreateThread={canStartThreads}
					onmove={(room) => moveSelection(room)} onnewthread={() => moveSelection('new')} onfill={() => selection.fillBetween(selectableOrder)}
					oncancel={() => { selection.cancel(); composer?.focus(); }}
				/>
			{:else}
				<Composer
					bind:this={composer}
					bind:value={composerText}
					bind:mentions={composerMentions}
					placeholder={activeThread ? `Reply in ${threadTitle(activeThread)}` : `Message ${activeRoom.title}`}
					disabled={!canCompose}
					canUpload={snapshot.capabilities['embed:upload']}
					canCommand={snapshot.capabilities.command}
					{people}
					replyPreview={replyId ? replyPreview(replyId) : undefined}
					oninput={composerInput} onsend={sendMessage} onfiles={sendFiles} oncancelreply={cancelReply}
					onmention={() => listMembers(MEMBERS_FRESH_MS)}
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
				<button class="ap-btn ap-btn-sm" type="button" onclick={() => openConnect()}>Connect to a backend</button>
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
	.typing-row { min-height: 20px; padding-top: var(--space-1); }
	/* A zero-height sticky row, so the pill floats over the timeline without taking space. */
	.day-float { position: sticky; top: var(--space-2); z-index: 2; height: 0; display: flex; justify-content: center; pointer-events: none; }
	.day-float span { padding: 3px var(--space-3); border-radius: var(--radius-full); background: var(--bg-200); border: 1px solid var(--line); box-shadow: var(--shadow-float); color: var(--ink); font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; opacity: 0; transform: translateY(-4px); transition: opacity .2s, transform .2s; }
	.day-float-shown span { opacity: 1; transform: none; }
	@media (prefers-reduced-motion: reduce) { .day-float span { transition: none; transform: none; } }
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
