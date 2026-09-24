<script lang="ts" module>
	export type Scheme = 'guest' | 'webauthn';
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { normalizeWebSocketUrl, type ChatClient } from '$lib/protocol/client';
	import { passkeyMessage } from '$lib/ui/connection';
	import { initials } from '$lib/ui/messages';
	import type { SessionView } from '$lib/ui/session.svelte';
	import { saveDisplayName, saveServerUrl, type RecentServer } from '$lib/ui/storage';
	import TypingDots from './TypingDots.svelte';

	const SCHEMES: Record<Scheme, { label: string; hint: string }> = {
		guest: { label: 'Guest', hint: 'No token needed; the server picks a guest identity.' },
		webauthn: { label: 'Passkey', hint: 'Signs in with a passkey on this device, or creates one. Your display name comes along.' }
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
		/** Preselects a scheme, e.g. when the profile asks to sign in with a passkey. */
		initialScheme?: Scheme;
		/** The form was submitted for another backend: the page drops whatever belonged to the previous one. */
		onconnect: () => void;
		/** The socket is up and signed in. */
		onconnected: () => void;
		oncancel: () => void;
		/** Signing out starts a different session: the page drops what it held from this one. */
		onsignout: () => void;
	}
	let {
		client, session, serverInput = $bindable(), displayName = $bindable(), passkeyUnavailable, recentServers, canCancel,
		initialScheme, onconnect, onconnected, oncancel, onsignout
	}: Props = $props();

	// The initial choice follows the request or the current session; the segmented control owns it from then on.
	let scheme = $state<Scheme>(untrack(() => initialScheme ?? (session.snapshot.passkeySession ? 'webauthn' : 'guest')));
	/** Waiting for a connection (and guest auth) to the server in the form. */
	let pending = $state(false);
	/** Connected to a new backend as a guest; the passkey waits for a tap, since browsers may refuse a prompt the user didn't start. */
	let passkeyStep = $state(false);
	let error = $state('');
	let plan = $state<'immediate' | 'login' | 'register'>('register');
	let snapshot = $derived(session.snapshot);
	let normalizedInput = $derived.by(() => {
		try {
			return normalizeWebSocketUrl(serverInput, window.location);
		} catch {
			return serverInput.trim();
		}
	});
	/** The form names the backend this client is already signed in to, so sign-in can happen in place. */
	let here = $derived(normalizedInput === client.url && snapshot.status === 'connected' && snapshot.authenticated);
	let passkeySession = $derived(!!snapshot.passkeySession);
	let passkeyHint = $derived(!!snapshot.passkeyHint);
	/** Sign-in schemes this client can drive, narrowed to what the connected server offers once it is the one in the field. */
	let schemes = $derived.by((): Scheme[] => {
		const supported: Scheme[] = passkeyUnavailable ? ['guest'] : ['guest', 'webauthn'];
		const offered = session.server?.auth;
		if (!offered || normalizedInput !== client.url) return supported;
		const narrowed = supported.filter((candidate) => offered.includes(candidate));
		return narrowed.length ? narrowed : supported;
	});
	let chosen = $derived(schemes.includes(scheme) ? scheme : schemes[0]);
	/** A passkey ceremony can start from this tap: signed in here as a guest. */
	let passkeyNow = $derived(chosen === 'webauthn' && !passkeySession && here);
	let status = $derived.by((): 'idle' | 'connecting' | 'authing' => {
		if (snapshot.authBusy) return 'authing';
		if (!pending) return 'idle';
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
	let submitLabel = $derived(
		status === 'connecting' ? 'Connecting…' : status === 'authing' ? 'Signing in…'
			: passkeyNow ? 'Continue with passkey'
			: here && chosen === 'guest' && passkeySession ? 'Sign out'
			: here ? 'Done' : 'Connect'
	);

	// A new backend signs in as a guest first; a passkey choice then waits for a tap.
	$effect(() => {
		if (!pending || snapshot.authBusy || !session.ready) return;
		pending = false;
		if (chosen === 'webauthn' && !snapshot.passkeySession) {
			passkeyStep = true;
			return;
		}
		finish();
	});

	$effect(() => {
		void passkeyHint;
		let current = true;
		void client.passkeyPlan().then((next) => {
			if (current) plan = next;
		});
		return () => (current = false);
	});

	// Existing passkeys are offered in the display name field's autofill whenever a tap could sign in.
	$effect(() => {
		if (!passkeyNow || passkeyUnavailable) return;
		const controller = new AbortController();
		void autofill(controller.signal);
		return () => controller.abort();
	});

	async function autofill(signal: AbortSignal): Promise<void> {
		try {
			const result = await client.passkeyAutofill(signal, () => displayName.trim() || undefined);
			if (result) finish();
		} catch (cause) {
			error = passkeyMessage(cause);
		}
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		error = '';
		let normalized: string;
		try {
			normalized = normalizeWebSocketUrl(serverInput, window.location);
			const parsed = new URL(normalized);
			if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('Use a ws:// or wss:// URL');
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Invalid server URL';
			return;
		}
		serverInput = normalized;
		displayName = displayName.trim();
		saveServerUrl(normalized);
		saveDisplayName(displayName);
		if (passkeyNow) {
			void passkey('continue');
		} else if (here && chosen === 'guest' && passkeySession) {
			void signOut();
		} else if (here) {
			if (displayName && displayName !== snapshot.you?.name) client.setDisplayName(displayName);
			finish();
		} else {
			connect(normalized);
		}
	}

	/** Opens the socket to another backend; the effect above finishes once the server answers. */
	function connect(normalized: string): void {
		client.setDisplayName(displayName);
		onconnect();
		passkeyStep = false;
		pending = true;
		if (normalized !== client.url) client.setUrl(normalized);
		else client.restart();
	}

	/** Runs straight from the tap, so the browser sees the user asked for it. */
	async function passkey(action: 'continue' | 'register' | 'login'): Promise<void> {
		error = '';
		const name = displayName.trim() || undefined;
		try {
			if (action === 'continue') await client.continueWithPasskey(name);
			else await client.usePasskey(action, name);
			finish();
		} catch (cause) {
			error = passkeyMessage(cause);
		}
	}

	async function signOut(): Promise<void> {
		try {
			onsignout();
			await client.signOut();
			pending = true;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Unable to sign out';
		}
	}

	function finish(): void {
		pending = false;
		passkeyStep = false;
		onconnected();
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
			<input class="ap-field" data-testid="connect-name-input" bind:value={displayName} placeholder="How others see you" disabled={busy} maxlength="64" autocomplete={chosen === 'webauthn' ? 'username webauthn' : 'nickname'} spellcheck="false" />
		</label>
		<div class="ap-fieldlabel">Sign in with
			<div class="ap-seg" role="radiogroup" aria-label="Sign in with">
				{#each schemes as candidate (candidate)}
					<button class="ap-seg-item" class:ap-seg-on={chosen === candidate} type="button" role="radio" aria-checked={chosen === candidate} disabled={busy} onclick={() => (scheme = candidate)}>{SCHEMES[candidate].label}</button>
				{/each}
			</div>
		</div>
		{#if passkeyStep && passkeyNow}
			<p class="ap-profedit-hint" role="status">Connected as a guest. Continue with a passkey to sign in, or stay a guest.</p>
		{:else if here && chosen === 'webauthn' && passkeySession}
			<p class="ap-profedit-hint">Signed in with a passkey. Choose Guest to sign out.</p>
		{:else}
			<p class="ap-profedit-hint">{SCHEMES[chosen].hint}</p>
		{/if}
		{#if passkeyNow}
			<button class="ap-link ap-connect-other" type="button" data-testid="other-passkey" disabled={busy} onclick={() => passkey(plan === 'login' ? 'register' : 'login')}>
				{plan === 'immediate' ? 'Use a passkey from another device' : plan === 'login' ? 'Create a new passkey' : 'Sign in with an existing passkey'}
			</button>
		{/if}
		{#if errorText}<p class="ap-profedit-note ap-profedit-err" role="alert">{errorText}</p>{/if}
		<div class="ap-connect-actions">
			{#if busy}<TypingDots />{/if}
			{#if passkeyStep && passkeyNow}
				<button class="ap-btn ap-btn-ghost" type="button" onclick={() => { client.cancelPasskeyPrompt(); finish(); }}>Stay a guest</button>
			{:else if canCancel}
				<button class="ap-btn ap-btn-ghost" type="button" onclick={() => { client.cancelPasskeyPrompt(); oncancel(); }}>Cancel</button>
			{/if}
			<button class="ap-btn ap-btn-primary" type="submit" disabled={busy}>{submitLabel}</button>
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
	.ap-connect-other { align-self: flex-start; font-size: 13px; }
</style>
