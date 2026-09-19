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
import { isJsonObject, type Embed, type EventRecord } from '$lib/protocol/types';

	type Feedback = { kind: 'pending' | 'sent' | 'error'; text: string };

	const blankSnapshot = (): ClientSnapshot => ({
		status: 'idle', rooms: [], pending: [], typing: [], showReconnectDivider: false
	});

	let snapshot = $state<ClientSnapshot>(blankSnapshot());
	let serverInput = $state('');
	let displayName = $state('');
	let composerText = $state('');
	let settingsOpen = $state(false);
	let editingId = $state<string | undefined>();
	let editDraft = $state('');
	let feedback = $state<Feedback | undefined>();
	let client: ChatClient | undefined;
	let composer = $state<HTMLTextAreaElement | undefined>();
	let messageScroll = $state<HTMLDivElement | undefined>();
	let stickToBottom = $state(true);
	let typingTimer: ReturnType<typeof setTimeout> | undefined;
	let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

	let activeRoom = $derived(snapshot.rooms.find((room) => room.id === snapshot.activeRoom));
	let messages = $derived(timelineMessages(activeRoom));
	let canCompose = $derived(Boolean(activeRoom && snapshot.status === 'connected' && snapshot.you));
	let canEdit = $derived(snapshot.server?.caps?.includes('edit') === true);
	let roomTyping = $derived(snapshot.typing.filter((entry) => entry.room === activeRoom?.id));

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
		if (snapshot.status === 'connecting') return 'Connecting';
		if (snapshot.status === 'reconnecting') return 'Reconnecting';
		if (snapshot.status === 'offline') return 'Offline';
		return 'Waiting to connect';
	}

	function applySettings(event: SubmitEvent): void {
		event.preventDefault();
		if (!client) return;
		try {
			const normalized = normalizeWebSocketUrl(serverInput, window.location);
			const parsed = new URL(normalized);
			if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('Use a ws:// or wss:// URL');
			serverInput = normalized;
			localStorage.setItem('bottomless.serverUrl', normalized);
			localStorage.setItem('bottomless.displayName', displayName.trim());
			client.setUrl(normalized);
			client.setDisplayName(displayName);
			settingsOpen = false;
		} catch (cause) {
			feedback = { kind: 'error', text: cause instanceof Error ? cause.message : 'Invalid server URL' };
		}
	}

	function chooseRoom(room: RoomSnapshot): void {
		client?.selectRoom(room.id);
		composer?.focus();
	}

	function composerInput(): void {
		if (!client || !activeRoom) return;
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
		if (!client || !activeRoom || !canCompose || !composerText.trim()) return;
		const draft = composerText;
		const handle = client.sendMessage(activeRoom.id, draft, 'markdown');
		track(handle, 'Sending message…', 'Message sent', () => {
			if (!composerText) composerText = draft;
			composer?.focus();
		});
		composerText = '';
		client.sendTyping(activeRoom.id, false);
		if (typingTimer) clearTimeout(typingTimer);
		composer?.focus();
	}

	function beginEdit(event: EventRecord): void {
		editingId = event.event_id;
		editDraft = typeof event.body?.text === 'string' ? event.body.text : '';
	}

	function saveEdit(event: EventRecord): void {
		if (!client || !activeRoom || !canEdit || !editDraft.trim()) return;
		track(client.updateMessage(activeRoom.id, event.event_id, editDraft), 'Saving edit…', 'Edit saved');
		editingId = undefined;
		editDraft = '';
	}

	function deleteMessage(event: EventRecord): void {
		if (!client || !activeRoom || !canEdit) return;
		track(client.deleteMessage(activeRoom.id, event.event_id), 'Deleting message…', 'Message deleted');
	}

	function track(handle: OperationHandle, pendingText: string, sentText: string, onError?: () => void): void {
		feedback = { kind: 'pending', text: pendingText };
		if (feedbackTimer) clearTimeout(feedbackTimer);
		handle.promise
			.then(() => {
				feedback = { kind: 'sent', text: sentText };
				feedbackTimer = setTimeout(() => (feedback = undefined), 3500);
			})
			.catch((cause: Error) => {
				feedback = { kind: 'error', text: cause.message };
				onError?.();
			});
	}

	function isOwn(event: EventRecord): boolean {
		return Boolean(snapshot.you && event.sender?.id === snapshot.you.id);
	}

	function senderName(event: EventRecord): string {
		return event.sender?.name || event.sender?.id || 'Unknown sender';
	}

	function eventTime(event: EventRecord): string {
		const millis = Number(event.event_id);
		return Number.isSafeInteger(millis) && millis > 0
			? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(millis)
			: '';
	}

	function textOf(event: EventRecord): string {
		return typeof event.body?.text === 'string' ? event.body.text : '';
	}

	function embedsOf(event: EventRecord): Embed[] {
		return Array.isArray(event.body?.embeds)
			? event.body.embeds.filter(isJsonObject).filter((embed): embed is Embed => typeof embed.kind === 'string')
			: [];
	}

	function trackScroll(): void {
		if (!messageScroll) return;
		stickToBottom = messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight < 96;
	}
</script>

<svelte:head>
	<title>Bottomless Chat</title>
	<meta name="description" content="A resilient chat client for the Bottomless Chat protocol." />
</svelte:head>

<div class="app-shell">
	<header class="topbar">
		<div class="brand-mark" aria-hidden="true">B</div>
		<div class="brand-copy"><span>Bottomless</span><strong>Chat</strong></div>
		<div class="spacer"></div>
		<div class="connection-state">
			<span class:online={snapshot.status === 'connected'} class:pending={snapshot.status === 'connecting' || snapshot.status === 'reconnecting'} class="status-dot" aria-hidden="true"></span>
			<span data-testid="connection-status" role="status" aria-live="polite">{statusLabel()}</span>
		</div>
		<button class="icon-button" type="button" aria-label="Connection settings" aria-expanded={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)}>⚙</button>
	</header>

	{#if settingsOpen}
		<form class="settings-panel" aria-label="Connection settings" onsubmit={applySettings}>
			<div class="settings-title"><div><small>SESSION</small><h2>Connection settings</h2></div><button class="link-button" type="button" onclick={() => (settingsOpen = false)}>Close</button></div>
			<div class="settings-fields">
				<label><span>Server URL</span><input data-testid="server-url-input" bind:value={serverInput} placeholder="ws://localhost:8080/ws" autocomplete="url" /></label>
				<label><span>Display name <small>optional</small></span><input data-testid="display-name-input" bind:value={displayName} placeholder="Anonymous" maxlength="80" autocomplete="nickname" /></label>
			</div>
			<button class="primary-button" type="submit">Reconnect</button>
		</form>
	{/if}

	<div class="workspace">
		<aside class="sidebar" aria-label="Rooms">
			<div class="sidebar-title"><div><small>YOUR SPACES</small><h2>Rooms</h2></div><b>{snapshot.rooms.length}</b></div>
			<div class="room-list" data-testid="room-list">
				{#if snapshot.rooms.length === 0}
					<p class="muted">Waiting for rooms…</p>
				{:else}
					{#each snapshot.rooms as room (room.id)}
						<button class:selected={room.id === snapshot.activeRoom} class="room-button" type="button" data-room={room.id} aria-pressed={room.id === snapshot.activeRoom} onclick={() => chooseRoom(room)}>
							<span aria-hidden="true">#</span><strong>{room.name}</strong>{#if room.recovering}<i aria-label="Loading history"></i>{/if}
						</button>
					{/each}
				{/if}
			</div>
			<div class="identity"><div class="avatar">{(snapshot.you?.name || snapshot.you?.id || '?')[0]?.toUpperCase()}</div><div><strong>{snapshot.you?.name || snapshot.you?.id || 'Guest'}</strong><small>{snapshot.server?.name || 'Anonymous session'}</small></div></div>
		</aside>

		<main class="conversation" aria-label="Conversation">
			{#if activeRoom}
				<header class="conversation-header">
					<div class="room-heading"><span aria-hidden="true">#</span><div><h2>{activeRoom.name}</h2><p>{activeRoom.topic || 'Open conversation'}</p></div></div>
					{#if activeRoom.recovering}<span class="history-state" role="status"><i></i>Loading history</span>{:else if activeRoom.recoveryError}<span class="history-state warning" role="status">History unavailable</span>{/if}
				</header>
				<div class="message-scroll" bind:this={messageScroll} onscroll={trackScroll} data-testid="message-list" role="log" aria-live="polite" aria-label={`${activeRoom.name} messages`}>
					{#if snapshot.showReconnectDivider}<div class="divider" data-testid="reconnect-divider"><span>New session</span></div>{/if}
					{#if messages.length === 0 && !activeRoom.recovering}
						<div class="empty"><div class="empty-symbol" aria-hidden="true">✦</div><h3>A quiet beginning</h3><p>Start the conversation in <strong>#{activeRoom.name}</strong>.</p></div>
					{:else}
						<div class="message-stack">
							{#each messages as event (event.event_id)}
								<article class:own={isOwn(event)} class="message" data-message-id={event.event_id} data-event-id={event.event_id}>
									<div class="message-avatar" aria-hidden="true">{senderName(event)[0]?.toUpperCase()}</div>
									<div class="message-body">
										<div class="message-meta"><strong>{senderName(event)}</strong>{#if isOwn(event)}<em>you</em>{/if}<time>{eventTime(event)}</time></div>
										{#if editingId === event.event_id}
											<div class="edit-form"><textarea aria-label="Edit message" bind:value={editDraft} rows="3"></textarea><div><button class="primary-button small" type="button" onclick={() => saveEdit(event)}>Save changes</button><button class="link-button" type="button" onclick={() => (editingId = undefined)}>Cancel</button></div></div>
										{:else if event.deleted}
											<p class="deleted">Message deleted</p>
										{:else}
											{#if textOf(event)}
												{#if event.body?.format === 'plain'}<p class="plain">{textOf(event)}</p>{:else}<div class="markdown">{@html renderMarkdown(textOf(event))}</div>{/if}
											{/if}
											{#each embedsOf(event) as embed}
												{@const url = safeUrl(embed.url)}
												<div class="embed">
													{#if embed.kind === 'image' && url}<img src={url} alt={embed.name || 'Shared image'} loading="lazy" />
													{:else if embed.kind === 'video' && url}<!-- svelte-ignore a11y_media_has_caption --><video src={url} controls preload="metadata" aria-label={embed.name || 'Shared video'}></video>
													{:else if embed.kind === 'audio' && url}<audio src={url} controls preload="metadata" aria-label={embed.name || 'Shared audio'}></audio>
													{:else if embed.kind === 'file' && url}<a href={url} target="_blank" rel="noopener noreferrer">↗ <strong>{embed.name || 'Download file'}</strong>{#if embed.size}<small> · {formatBytes(embed.size)}</small>{/if}</a>
													{:else}<div class="unknown-embed"><strong>Unsupported attachment: {embed.kind || 'unknown'}</strong>{#if url}<a href={url} target="_blank" rel="noopener noreferrer">Open attachment</a>{/if}</div>
													{/if}
												</div>
											{/each}
										{/if}
										{#if canEdit && isOwn(event) && !event.deleted}<div class="message-actions"><button type="button" aria-label="Edit message" onclick={() => beginEdit(event)}>Edit</button><button type="button" aria-label="Delete message" onclick={() => deleteMessage(event)}>Delete</button></div>{/if}
									</div>
								</article>
							{/each}
						</div>
					{/if}
				</div>
				{#if roomTyping.length > 0}<div class="typing" role="status"><span>•••</span> {roomTyping.map((entry) => entry.sender.name || entry.sender.id).join(', ')} {roomTyping.length === 1 ? 'is' : 'are'} typing</div>{/if}
				<form class="composer" aria-label="Send a message" onsubmit={(event) => { event.preventDefault(); sendMessage(); }}>
					<label class="sr-only" for="message-input">Message</label>
					<textarea id="message-input" data-testid="message-input" aria-label="Message" bind:this={composer} bind:value={composerText} oninput={composerInput} onkeydown={composerKeydown} disabled={!canCompose} placeholder={canCompose ? 'Write a message…' : 'Connecting to the room…'} rows="1" aria-describedby="composer-help"></textarea>
					<button class="send-button" data-testid="send-button" type="submit" aria-label="Send message" disabled={!canCompose || !composerText.trim()}>↑</button>
					<span id="composer-help">Enter to send · Shift + Enter for a new line</span>
				</form>
			{:else}
				<div class="no-room"><p>Connect to a server to see its rooms.</p><button class="link-button" type="button" onclick={() => (settingsOpen = true)}>Open connection settings</button></div>
			{/if}
		</main>
	</div>
	{#if feedback}<div class="feedback {feedback.kind}" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</div>{/if}
	{#if snapshot.error}<div class="connection-error" role="alert">{snapshot.error}</div>{/if}
</div>

<style>
	:global(*) { box-sizing: border-box; }
	:global(html) { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #17202d; background: #f4f6f9; }
	:global(body) { margin: 0; min-width: 320px; background: #f4f6f9; }
	:global(button), :global(input), :global(textarea) { font: inherit; }
	:global(button) { cursor: pointer; }
	.app-shell { min-height: 100vh; background: #f4f6f9; }
	.topbar { height: 76px; display: flex; align-items: center; gap: 12px; padding: 0 28px; background: #fff; border-bottom: 1px solid #e6eaf0; }
	.brand-mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 12px; background: #1e5eff; color: #fff; font-weight: 800; box-shadow: 0 5px 14px #1e5eff38; }
	.brand-copy { display: flex; flex-direction: column; gap: 1px; line-height: 1; }
	.brand-copy span { color: #7d8798; font-size: 10px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
	.brand-copy strong { font-size: 17px; letter-spacing: -.02em; }
	.spacer { flex: 1; }
	.connection-state { display: inline-flex; align-items: center; gap: 8px; color: #667085; font-size: 12px; font-weight: 650; }
	.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #98a2b3; }
	.status-dot.online { background: #13b978; box-shadow: 0 0 0 4px #13b9781c; }
	.status-dot.pending { background: #f0a524; animation: pulse 1.4s ease-in-out infinite; }
	.icon-button { width: 34px; height: 34px; border: 0; border-radius: 9px; background: transparent; color: #667085; font-size: 17px; }
	.icon-button:hover, .icon-button:focus-visible { background: #f0f3f8; color: #1e5eff; }
	.workspace { max-width: 1440px; height: calc(100vh - 76px); min-height: 560px; margin: 0 auto; display: grid; grid-template-columns: 244px minmax(0, 1fr); background: #fff; box-shadow: 0 22px 60px #1e2d4b14; }
	.sidebar { min-width: 0; display: flex; flex-direction: column; padding: 26px 13px 14px; background: #f8f9fb; border-right: 1px solid #e8ebf0; }
	.sidebar-title { display: flex; justify-content: space-between; align-items: flex-start; padding: 0 11px 16px; }
	.sidebar-title small, .settings-title small { color: #7d8798; font-size: 10px; font-weight: 750; letter-spacing: .13em; }
	.sidebar-title h2, .settings-title h2 { margin: 4px 0 0; font-size: 19px; letter-spacing: -.025em; }
	.sidebar-title b { min-width: 24px; padding: 4px 7px; border-radius: 8px; background: #edf1f7; color: #697586; font-size: 11px; text-align: center; }
	.room-list { display: flex; flex-direction: column; gap: 3px; }
	.room-button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 10px 11px; border: 0; border-radius: 9px; background: transparent; color: #667085; text-align: left; transition: 140ms ease; }
	.room-button:hover { background: #eef2f8; color: #344054; }
	.room-button.selected { background: #e9efff; color: #1e5eff; font-weight: 700; }
	.room-button > span { color: #98a2b3; font-size: 18px; }
	.room-button strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
	.room-button i, .history-state i { width: 12px; height: 12px; margin-left: auto; border: 2px solid #d5dce8; border-top-color: #1e5eff; border-radius: 50%; animation: spin .7s linear infinite; }
	.muted { padding: 4px 11px; color: #98a2b3; font-size: 12px; }
	.identity { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 12px 10px 2px; border-top: 1px solid #e6eaf0; }
	.avatar, .message-avatar { flex: 0 0 auto; display: grid; place-items: center; border-radius: 10px; background: #dce6ff; color: #2856cf; font-weight: 750; }
	.avatar { width: 29px; height: 29px; font-size: 12px; }
	.identity > div:last-child { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.identity strong, .identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.identity strong { font-size: 12px; }
	.identity small { color: #98a2b3; font-size: 10px; }
	.conversation { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #fff; }
	.conversation-header { min-height: 83px; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 18px 32px; border-bottom: 1px solid #edf0f4; }
	.room-heading { display: flex; align-items: center; gap: 13px; }
	.room-heading > span { color: #8293b3; font-size: 28px; }
	.room-heading h2, .room-heading p { margin: 0; }
	.room-heading h2 { font-size: 18px; letter-spacing: -.02em; }
	.room-heading p { margin-top: 4px; color: #98a2b3; font-size: 12px; }
	.history-state { display: inline-flex; align-items: center; gap: 7px; color: #6680be; font-size: 11px; font-weight: 650; }
	.history-state.warning { color: #aa7110; }
	.message-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 25px 32px 18px; scroll-behavior: smooth; }
	.message-stack { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
	.message { display: flex; align-items: flex-start; gap: 12px; }
	.message-avatar { width: 34px; height: 34px; background: #eff1f5; color: #667085; font-size: 13px; }
	.message.own .message-avatar { background: #dfe8ff; color: #1e5eff; }
	.message-body { min-width: 0; flex: 1; padding-top: 1px; }
	.message-meta { display: flex; align-items: baseline; gap: 7px; margin-bottom: 6px; }
	.message-meta strong { font-size: 13px; }
	.message-meta em { padding: 2px 5px; border-radius: 4px; background: #edf2ff; color: #5276d7; font-size: 9px; font-style: normal; font-weight: 750; text-transform: uppercase; }
	.message-meta time { color: #a2aab8; font-size: 10px; }
	.plain, .markdown, .deleted { margin: 0; color: #475467; font-size: 14px; line-height: 1.65; word-break: break-word; }
	.plain { white-space: pre-wrap; }
	.deleted { color: #98a2b3; font-style: italic; }
	:global(.markdown p) { margin: 0 0 8px; }
	:global(.markdown p:last-child) { margin-bottom: 0; }
	:global(.markdown a) { color: #1e5eff; text-decoration: underline; text-underline-offset: 2px; }
	:global(.markdown pre) { margin: 10px 0; overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: #192235; color: #dce5f7; font-size: 12px; }
	:global(.markdown code) { padding: 2px 4px; border-radius: 4px; background: #f0f2f6; font-size: .9em; }
	:global(.markdown pre code) { padding: 0; background: transparent; }
	:global(.markdown blockquote) { margin: 8px 0; padding-left: 12px; border-left: 3px solid #d6def0; color: #667085; }
	.message-actions { display: flex; gap: 10px; margin-top: 7px; opacity: 0; transition: opacity 120ms ease; }
	.message:hover .message-actions, .message:focus-within .message-actions { opacity: 1; }
	.message-actions button { padding: 0; border: 0; background: transparent; color: #8290a6; font-size: 10px; }
	.message-actions button:hover, .message-actions button:focus-visible { color: #1e5eff; text-decoration: underline; }
	.edit-form { max-width: 620px; }
	.edit-form textarea, .composer textarea, .settings-panel input { width: 100%; border: 1px solid #d9e0eb; border-radius: 9px; background: #fff; color: #344054; outline: none; }
	.edit-form textarea:focus, .composer textarea:focus, .settings-panel input:focus { border-color: #6b8eeb; box-shadow: 0 0 0 3px #1e5eff1c; }
	.edit-form textarea { padding: 10px; resize: vertical; font-size: 13px; line-height: 1.5; }
	.edit-form > div { display: flex; gap: 10px; align-items: center; margin-top: 7px; }
	.embed { max-width: 520px; margin-top: 9px; overflow: hidden; border: 1px solid #e1e6ef; border-radius: 10px; background: #fbfcfe; }
	.embed img, .embed video { display: block; max-width: 100%; max-height: 360px; object-fit: contain; background: #eef1f6; }
	.embed audio { display: block; width: min(100%, 450px); padding: 8px; }
	.embed a, .unknown-embed { display: flex; align-items: center; gap: 8px; padding: 11px 13px; color: #475467; font-size: 12px; text-decoration: none; }
	.embed a:hover { background: #f2f5fb; }
	.embed small { color: #98a2b3; }
	.unknown-embed { justify-content: space-between; flex-wrap: wrap; }
	.unknown-embed a { padding: 0; color: #1e5eff; text-decoration: underline; }
	.divider { max-width: 820px; display: flex; align-items: center; gap: 13px; margin: 0 auto 20px; color: #95a0b2; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
	.divider::before, .divider::after { content: ''; height: 1px; flex: 1; background: #e6eaf0; }
	.empty, .no-room { min-height: 250px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 8px; color: #98a2b3; text-align: center; }
	.empty-symbol { width: 48px; height: 48px; display: grid; place-items: center; margin-bottom: 5px; border-radius: 15px; background: #edf2ff; color: #6e8ce0; font-size: 22px; }
	.empty h3, .empty p, .no-room p { margin: 0; }
	.empty h3 { color: #475467; font-size: 16px; }
	.empty p, .no-room p { font-size: 13px; }
	.typing { min-height: 25px; padding: 0 32px; color: #8290a6; font-size: 11px; }
	.typing span { letter-spacing: 2px; }
	.composer { position: relative; max-width: 884px; width: calc(100% - 64px); margin: 6px auto 20px; }
	.composer textarea { min-height: 53px; max-height: 170px; padding: 16px 56px 25px 16px; resize: vertical; font-size: 13px; line-height: 1.45; }
	.composer textarea:disabled { background: #f8f9fb; cursor: not-allowed; }
	.send-button { position: absolute; right: 10px; top: 10px; width: 32px; height: 32px; border: 0; border-radius: 8px; background: #1e5eff; color: #fff; font-size: 18px; }
	.send-button:hover:not(:disabled), .send-button:focus-visible:not(:disabled) { background: #1449d0; }
	.send-button:disabled { background: #d9e0eb; cursor: not-allowed; }
	#composer-help { position: absolute; left: 16px; bottom: 5px; color: #a2aab8; font-size: 9px; }
	.link-button { padding: 4px 0; border: 0; background: transparent; color: #1e5eff; font-size: 12px; }
	.link-button:hover, .link-button:focus-visible { text-decoration: underline; }
	.primary-button { padding: 9px 13px; border: 0; border-radius: 8px; background: #1e5eff; color: #fff; font-size: 12px; font-weight: 700; }
	.primary-button:hover, .primary-button:focus-visible { background: #1449d0; }
	.primary-button.small { padding: 6px 10px; font-size: 11px; }
	.settings-panel { position: absolute; z-index: 5; top: 88px; right: 28px; width: min(520px, calc(100% - 32px)); padding: 21px; border: 1px solid #e0e6f0; border-radius: 13px; background: #fff; box-shadow: 0 17px 45px #20304f29; }
	.settings-title { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
	.settings-title h2 { margin: 4px 0 0; font-size: 19px; }
	.settings-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.settings-fields label { display: flex; flex-direction: column; gap: 7px; color: #475467; font-size: 11px; font-weight: 700; }
	.settings-fields label small { color: #98a2b3; font-weight: 500; }
	.settings-panel input { padding: 10px 11px; font-size: 12px; }
	.settings-panel > .primary-button { margin-top: 16px; }
	.feedback, .connection-error { position: fixed; z-index: 10; bottom: 22px; padding: 10px 14px; border-radius: 8px; font-size: 12px; font-weight: 650; box-shadow: 0 8px 22px #20304f26; }
	.feedback { left: 50%; transform: translateX(-50%); }
	.feedback.pending { background: #fff7e6; color: #99650d; }
	.feedback.sent { background: #e8fbf3; color: #11784f; }
	.feedback.error, .connection-error { background: #fff0f0; color: #bd3434; }
	.connection-error { right: 22px; max-width: min(390px, calc(100% - 44px)); }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
	:global(:focus-visible) { outline: 3px solid #1e5eff59; outline-offset: 2px; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@keyframes pulse { 50% { opacity: .4; } }
	@media (max-width: 700px) {
		.topbar { padding: 0 17px; }
		.workspace { height: calc(100vh - 76px); grid-template-columns: 76px minmax(0, 1fr); }
		.sidebar { padding: 22px 9px 12px; }
		.sidebar-title { justify-content: center; padding: 0 0 15px; }
		.sidebar-title > div, .room-button strong, .room-button i, .identity > div:last-child { display: none; }
		.room-button { justify-content: center; padding: 11px 4px; }
		.room-button > span { font-size: 21px; }
		.identity { justify-content: center; padding: 12px 0 2px; }
		.conversation-header, .message-scroll { padding-left: 18px; padding-right: 18px; }
		.typing { padding: 0 18px; }
		.composer { width: calc(100% - 36px); }
		.settings-panel { top: 84px; right: 16px; }
		.settings-fields { grid-template-columns: 1fr; }
	}
</style>
