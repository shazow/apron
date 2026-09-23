<script lang="ts">
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
		onsignout: () => void;
	}
	let { client, session, backendLabel, threads, activeThread, mentions, displayName = $bindable(), passkeyUnavailable, onconnect, onroom, onthread, onsignout }: Props = $props();
	/** Threads are listed under their parent, not as rooms of their own. */
	let rooms = $derived(sidebarRooms(session.rooms));
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
										{#if entry.count !== undefined}
											<small class="room-meta" aria-label={`${entry.count} ${entry.count === 1 ? 'message' : 'messages'}`}>{entry.count}</small>
										{/if}
									</button>
								{/each}
							</div>
						{/if}
					{/each}
				{/if}
			</div>
		</section>
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
	@media (max-width: 719px) {
		.ap-shell-side { border-right: 0; }
	}
</style>
