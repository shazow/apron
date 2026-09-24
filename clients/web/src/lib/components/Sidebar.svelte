<script lang="ts">
	import { untrack } from 'svelte';
	import type { ChatClient, RoomSnapshot } from '$lib/protocol/client';
	import type { SessionView } from '$lib/ui/session.svelte';
	import { sidebarRooms, type ThreadEntry } from '$lib/ui/timeline';
	import ProfileBar from './ProfileBar.svelte';

	interface Props {
		client: ChatClient;
		session: SessionView;
		backendLabel: string;
		/** The active room's threads (rooms whose parent it is), listed under it. */
		threads: ThreadEntry[];
		activeThread?: string;
		/** Mentions of you that landed in rooms you weren't reading. */
		mentions: Record<string, number>;
		displayName: string;
		passkeyUnavailable?: string;
		onconnect: () => void;
		onroom: (room: RoomSnapshot) => void;
		onthread: (thread: string) => void;
		/** Join a visible room or thread from `room_list` (cap `rooms`); it opens once announced. */
		onjoin: (roomId: string) => void;
		onsignout: () => void;
	}
	let { client, session, backendLabel, threads, activeThread, mentions, displayName = $bindable(), passkeyUnavailable, onconnect, onroom, onthread, onjoin, onsignout }: Props = $props();
	/** Threads are listed under their parent, not as rooms of their own. */
	let rooms = $derived(sidebarRooms(session.rooms));
	let canBrowse = $derived(session.canManageRooms && session.ready);
	let browseOpen = $state(false);
	let moreThreadsFor = $state<string | undefined>();
	let listError = $state('');
	/** Visible rooms this user hasn't joined (or has left), from the latest `room_list`. */
	let unjoined = $derived((session.snapshot.directory ?? []).filter((listing) => !listing.joined));
	/** Threads of the active room this user hasn't joined, once `room_list` has listed them. */
	let unjoinedThreads = $derived(session.activeRoomId ? (session.snapshot.threadDirectory[session.activeRoomId] ?? []).filter((listing) => !listing.joined) : []);

	/** Changes whenever a room or thread is joined or left. */
	let joinedKey = $derived(session.rooms.map((room) => room.id).join('\u0000'));

	// Browse rooms and More threads… show only when there is something to join, so list both in the background
	// (the rooms, and the active room's threads) whenever the active room or what you've joined changes.
	$effect(() => {
		const roomId = session.activeRoomId;
		void joinedKey;
		if (!canBrowse) return;
		untrack(() => {
			client.listRooms().catch(() => {});
			if (roomId) client.listRooms(roomId).catch(() => {});
		});
	});

	function list(parentRoomId?: string): void {
		listError = '';
		client.listRooms(parentRoomId).catch((cause: unknown) => (listError = cause instanceof Error ? cause.message : 'Unable to list rooms'));
	}

	function toggleBrowse(): void {
		browseOpen = !browseOpen;
		if (browseOpen) list();
	}

	/** Servers may announce only some threads; the rest come from `room_list` with the parent (Appendix C). */
	function showMoreThreads(parentRoomId: string): void {
		moreThreadsFor = moreThreadsFor === parentRoomId ? undefined : parentRoomId;
		if (moreThreadsFor) list(parentRoomId);
	}
</script>

<aside class="ap-shell-side" aria-label="Rooms">
	<div class="ap-shell-sidehead">
		<span class="backend">{backendLabel}</span>
		<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" aria-label="Connection settings" onclick={onconnect}>Connect</button>
	</div>
	<div class="ap-shell-sidebody">
		<section class="ap-sect">
			<div class="ap-sect-head">
				<span class="ap-sect-toggle" role="heading" aria-level="2">Rooms</span>
			</div>
			<div class="ap-sect-body" data-testid="room-list">
				{#if rooms.length === 0}
					<p class="muted">{session.snapshot.status === 'connected' ? 'No rooms yet.' : 'Waiting for rooms…'}</p>
				{:else}
					{#each rooms as room (room.id)}
						{@const active = room.id === session.activeRoomId}
						{@const current = active && !activeThread}
						<button class="ap-room" class:ap-room-active={current} type="button" data-room={room.id} aria-current={current ? 'page' : undefined} onclick={() => onroom(room)}>
							<span class="ap-room-text">
								<span class="ap-room-name">{room.title}</span>
							</span>
							{#if mentions[room.id]}
								{@const count = mentions[room.id]}
								<span class="ap-count ap-count-at" data-testid="room-mentions" aria-label={`${count} ${count === 1 ? 'mention' : 'mentions'}`}>@{count > 1 ? count : ''}</span>
							{/if}
							{#if room.recovering}<span class="room-meta" aria-label="Loading history">…</span>{/if}
						</button>
						{#if active}
							<div class="threads" data-testid="thread-list" role="group" aria-label={`Threads in ${room.title}`}>
								{#each threads as entry (entry.id)}
									{@const open = activeThread === entry.id}
									<button class="ap-room ap-room-nested" class:ap-room-active={open} type="button" data-thread={entry.id} aria-current={open ? 'page' : undefined} onclick={() => onthread(entry.id)}>
										<span class="ap-room-text"><span class="ap-room-name">{entry.title}</span></span>
										{#if mentions[entry.id] && !open}
											{@const count = mentions[entry.id]}
											<span class="ap-count ap-count-at" data-testid="thread-mentions" aria-label={`${count} ${count === 1 ? 'mention' : 'mentions'}`}>@{count > 1 ? count : ''}</span>
										{/if}
										{#if entry.count !== undefined}
											<small class="room-meta" aria-label={`${entry.count} ${entry.count === 1 ? 'message' : 'messages'}`}>{entry.count}</small>
										{/if}
									</button>
								{/each}
								{#if canBrowse && unjoinedThreads.length > 0}
									<button class="ap-room ap-room-nested more" type="button" data-testid="more-threads" aria-expanded={moreThreadsFor === room.id} onclick={() => showMoreThreads(room.id)}>
										<span class="ap-room-text"><span class="ap-room-topic">More threads…</span></span>
									</button>
									{#if moreThreadsFor === room.id}
										{#each unjoinedThreads as listing (listing.id)}
											<button class="ap-room ap-room-nested" type="button" data-join={listing.id} onclick={() => onjoin(listing.id)}>
												<span class="ap-room-text"><span class="ap-room-name">{listing.title}</span><span class="ap-room-topic">Join</span></span>
											</button>
										{/each}
									{/if}
								{/if}
							</div>
						{/if}
					{/each}
				{/if}
			</div>
		</section>
		{#if canBrowse && unjoined.length > 0}
			<section class="ap-sect" class:ap-sect-closed={!browseOpen}>
				<div class="ap-sect-head">
					<button class="ap-sect-toggle" type="button" aria-expanded={browseOpen} data-testid="browse-rooms" onclick={toggleBrowse}><span class="ap-sect-caret" aria-hidden="true">▾</span>Browse rooms</button>
				</div>
				{#if browseOpen}
					<div class="ap-sect-body" data-testid="room-directory">
						{#each unjoined as listing (listing.id)}
							<button class="ap-room" type="button" data-join={listing.id} onclick={() => onjoin(listing.id)}>
								<span class="ap-room-text">
									<span class="ap-room-name">{listing.title}</span>
									<span class="ap-room-topic">{listing.members.length} {listing.members.length === 1 ? 'member' : 'members'} · Join</span>
								</span>
							</button>
						{/each}
						{#if listError}<p class="muted" role="alert">{listError}</p>{/if}
					</div>
				{/if}
			</section>
		{/if}
	</div>
	<ProfileBar {client} {session} {backendLabel} bind:displayName {passkeyUnavailable} {onsignout} />
</aside>

<style>
	.ap-shell-side { overflow: hidden; }
	.ap-shell-sidehead { gap: var(--space-2); }
	.backend { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.muted { margin: 0; padding: var(--space-1) var(--space-3); color: var(--ink-muted); font-size: 13px; line-height: 18px; }
	.threads { display: flex; flex-direction: column; gap: 2px; }
	.room-meta { flex: none; font-size: 12px; line-height: 16px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
	.ap-room-active .room-meta { color: var(--ink); }
	.more .ap-room-topic { color: var(--denim); }
	@media (max-width: 719px) {
		.ap-shell-side { border-right: 0; }
	}
</style>
