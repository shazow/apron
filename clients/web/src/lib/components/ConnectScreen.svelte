<script lang="ts">
	import { untrack } from 'svelte';
	import { normalizeWebSocketUrl, type ChatClient } from '$lib/protocol/client';
	import { passkeyMessage } from '$lib/ui/connection';
	import { initials } from '$lib/ui/messages';
	import type { SessionView } from '$lib/ui/session.svelte';
	import { saveDisplayName, saveServerUrl, type RecentServer } from '$lib/ui/storage';
	import TypingDots from './TypingDots.svelte';

	type Scheme = 'guest' | 'webauthn';
	const SCHEMES: Record<Scheme, { label: string; hint: string }> = {
		guest: { label: 'Guest', hint: 'No token needed; the server picks a guest identity.' },
		webauthn: { label: 'Passkey', hint: 'Your device will ask you to confirm.' }
	};

	interface Props {
		client: ChatClient;
		session: SessionView;
		serverInput: string;
		displayName: string;
		/** Why passkeys can't be used in this browser, when they can't. */
		passkeyUnavailable?: string;
		recentServers: RecentServer[];
		canCancel: boolean;
		/** The form was submitted: the page drops whatever belonged to the previous backend. */
		onconnect: () => void;
		/** The socket is up and signed in. */
		onconnected: () => void;
		oncancel: () => void;
	}
	let { client, session, serverInput = $bindable(), displayName = $bindable(), passkeyUnavailable, recentServers, canCancel, onconnect, onconnected, oncancel }: Props = $props();

	// The initial choice follows the current session; the segmented control owns it from then on.
	let scheme = $state<Scheme>(untrack(() => (session.snapshot.passkeySession && !passkeyUnavailable ? 'webauthn' : 'guest')));
	let pending = $state(false);
	let error = $state('');
	let snapshot = $derived(session.snapshot);
	/** Sign-in schemes this client can drive, narrowed to what the connected server offers once it is the one in the field. */
	let schemes = $derived.by((): Scheme[] => {
		const supported: Scheme[] = passkeyUnavailable ? ['guest'] : ['guest', 'webauthn'];
		const offered = session.server?.auth;
		if (!offered || serverInput.trim() !== client.url) return supported;
		const narrowed = supported.filter((candidate) => offered.includes(candidate));
		return narrowed.length ? narrowed : supported;
	});
	let chosen = $derived(schemes.includes(scheme) ? scheme : schemes[0]);
	let status = $derived.by((): 'idle' | 'connecting' | 'authing' => {
		if (!pending) return 'idle';
		if (snapshot.authBusy) return 'authing';
		if (snapshot.error) return 'idle';
		if (snapshot.status === 'connected') return session.ready ? 'idle' : 'authing';
		if (snapshot.status === 'connecting' || snapshot.status === 'reconnecting') return 'connecting';
		return 'idle';
	});
	let busy = $derived(status !== 'idle');
	let errorText = $derived.by(() => {
		if (error) return error;
		if (!pending || !snapshot.error) return '';
		return snapshot.error === 'WebSocket connection error' ? 'Can’t reach the server. Check the address and try again.' : snapshot.error;
	});

	// Guest auth lands first; a passkey choice then upgrades the session.
	$effect(() => {
		if (!pending || snapshot.authBusy || !session.ready) return;
		if (chosen === 'webauthn' && !snapshot.passkeySession) {
			pending = false;
			void finishWithPasskey();
			return;
		}
		finish();
	});

	/** Opens the socket to the server in the form; the effect above signs in with the chosen scheme once the server answers. */
	function submit(event: SubmitEvent): void {
		event.preventDefault();
		error = '';
		try {
			const normalized = normalizeWebSocketUrl(serverInput, window.location);
			const parsed = new URL(normalized);
			if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('Use a ws:// or wss:// URL');
			serverInput = normalized;
			displayName = displayName.trim();
			saveServerUrl(normalized);
			saveDisplayName(displayName);
			client.setDisplayName(displayName);
			onconnect();
			pending = true;
			if (normalized !== client.url) client.setUrl(normalized);
			else client.restart();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Invalid server URL';
		}
	}

	function finish(): void {
		pending = false;
		onconnected();
	}

	/** Waits out the `name` request that follows guest auth, then swaps in the passkey identity. */
	async function finishWithPasskey(): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				await client.usePasskey('login');
				break;
			} catch (cause) {
				if (attempt < 20 && cause instanceof Error && cause.message.startsWith('Wait for pending requests')) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					continue;
				}
				error = passkeyMessage(cause);
				return;
			}
		}
		if (displayName) client.setDisplayName(displayName);
		finish();
	}
</script>

<div class="app ap-connect">
	<form class="ap-connect-card" aria-label="Connect to a backend" onsubmit={submit}>
		<h1 class="ap-connect-title">Apron</h1>
		<p class="ap-connect-tag">Connect to a backend</p>
		<label class="ap-fieldlabel">Server
			<input class="ap-field ap-field-mono" data-testid="server-url-input" type="text" inputmode="url" bind:value={serverInput} placeholder="wss://server.apron.chat/" disabled={busy} autocomplete="url" spellcheck="false" />
		</label>
		<label class="ap-fieldlabel">Display name
			<input class="ap-field" bind:value={displayName} placeholder="How others see you" disabled={busy} maxlength="64" autocomplete="nickname" />
		</label>
		<div class="ap-fieldlabel">Sign in with
			<div class="ap-seg" role="radiogroup" aria-label="Sign in with">
				{#each schemes as candidate (candidate)}
					<button class="ap-seg-item" class:ap-seg-on={chosen === candidate} type="button" role="radio" aria-checked={chosen === candidate} disabled={busy} onclick={() => (scheme = candidate)}>{SCHEMES[candidate].label}</button>
				{/each}
			</div>
		</div>
		<p class="ap-profedit-hint">{SCHEMES[chosen].hint}</p>
		{#if errorText}<p class="ap-profedit-note ap-profedit-err" role="alert">{errorText}</p>{/if}
		<div class="ap-connect-actions">
			{#if busy}<TypingDots />{/if}
			{#if canCancel}
				<button class="ap-btn ap-btn-ghost" type="button" onclick={oncancel}>Cancel</button>
			{/if}
			<button class="ap-btn ap-btn-primary" type="submit" disabled={busy}>{status === 'connecting' ? 'Connecting…' : status === 'authing' ? 'Signing in…' : 'Connect'}</button>
		</div>
	</form>
	{#if recentServers.length > 0}
		<div class="ap-connect-recent" role="group" aria-label="Recent backends">
			<span class="ap-fieldlabel">Recent</span>
			{#each recentServers as recent (recent.url)}
				<button class="ap-connect-recent-item" type="button" disabled={busy} onclick={() => { serverInput = recent.url; error = ''; }}>
					<span class="ap-rail-tile ap-connect-tile" aria-hidden="true">{initials(recent.label || recent.url)}</span>
					<span class="ap-room-text">
						<span class="ap-room-name">{recent.label || recent.url}</span>
						<span class="ap-room-topic">{recent.url}</span>
					</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.app { height: 100dvh; min-height: 100%; }
	.ap-connect .ap-btn-ghost { border-radius: calc(var(--radius-lg) - var(--space-2)); }
</style>
