<script lang="ts">
	import { isJsonObject } from '$lib/protocol/types';
	import type { ChatClient } from '$lib/protocol/client';
	import { passkeyMessage } from '$lib/ui/connection';
	import type { SessionView } from '$lib/ui/session.svelte';
	import { saveDisplayName } from '$lib/ui/storage';
	import Avatar from './Avatar.svelte';
	import TypingDots from './TypingDots.svelte';

	type Status = 'idle' | 'saving' | 'altered' | 'declined';

	interface Props {
		client: ChatClient;
		session: SessionView;
		backendLabel: string;
		displayName: string;
		passkeyUnavailable?: string;
		/** Signing out starts a different session: the page drops what it held from this one. */
		onsignout: () => void;
	}
	let { client, session, backendLabel, displayName = $bindable(), passkeyUnavailable, onsignout }: Props = $props();

	let open = $state(false);
	let draft = $state('');
	let status = $state<Status>('idle');
	let serverName = $state('');
	let passkeyError = $state('');
	let passkeyNotice = $state('');
	let you = $derived(session.you);
	let snapshot = $derived(session.snapshot);
	let connected = $derived(snapshot.status === 'connected');

	function toggle(): void {
		if (open) {
			close();
			return;
		}
		draft = you?.name || displayName;
		status = 'idle';
		serverName = '';
		passkeyError = '';
		passkeyNotice = '';
		open = true;
	}

	function close(): void {
		open = false;
		status = 'idle';
	}

	async function passkey(action: 'register' | 'login' | 'logout'): Promise<void> {
		passkeyError = '';
		passkeyNotice = '';
		try {
			if (action === 'logout') {
				onsignout();
				await client.signOut();
			} else {
				await client.usePasskey(action);
			}
			draft = you?.name || displayName;
			passkeyNotice = action === 'register' ? 'Passkey saved · this backend will ask your device next time'
				: action === 'login' ? 'Signed in with your passkey.' : 'Signed out.';
		} catch (cause) {
			passkeyError = passkeyMessage(cause);
		}
	}

	/** Sends the handle with `name`; the editor then shows what the server actually kept. */
	function save(event: SubmitEvent): void {
		event.preventDefault();
		const requested = draft.trim();
		if (!requested) return;
		displayName = requested;
		saveDisplayName(requested);
		const handle = client.setDisplayName(requested);
		if (!handle) {
			close();
			return;
		}
		status = 'saving';
		handle.promise
			.then((result) => {
				const kept = isJsonObject(result.you) && typeof result.you.name === 'string' ? result.you.name : requested;
				if (kept === requested) {
					close();
				} else {
					serverName = kept;
					status = 'altered';
				}
			})
			.catch(() => (status = 'declined'));
	}
</script>

<div class="ap-profile">
	{#if open}
		<div class="ap-profile-pop" role="dialog" aria-label="Edit profile">
			<form class="ap-profedit" onsubmit={save}>
				<div class="ap-profedit-top">
					<Avatar name={draft || you?.user_id || '?'} src={you?.avatar} size="lg" />
					<div class="ap-profedit-av">
						<span class="ap-profedit-hint">{session.canUpload ? 'Avatar uploads are not supported by this client yet.' : 'This backend has no upload URL, so your avatar can’t be set here.'}</span>
					</div>
				</div>
				<label class="ap-fieldlabel">Handle
					<input class="ap-field" data-testid="display-name-input" bind:value={draft} disabled={status === 'saving'} maxlength="64" autocomplete="nickname" spellcheck="false" />
				</label>
				<p class="ap-profedit-hint">ID <code>{you?.user_id ?? '—'}</code> · set by the server, can’t be changed</p>
				{#if status === 'altered'}
					<p class="ap-profedit-note" role="status">The server saved your handle as “{serverName}”.</p>
				{:else if status === 'declined'}
					<p class="ap-profedit-note ap-profedit-err" role="alert">The server declined this handle. Your old one is still in use.</p>
				{/if}
				{#if session.server?.auth.includes('webauthn')}
					<div class="ap-profedit-signin" role="group" aria-label="Sign-in">
						<span class="ap-fieldlabel">Sign-in</span>
						{#if snapshot.authBusy}
							<span class="ap-profedit-hint" role="status"><TypingDots /> Confirm on your device…</span>
						{:else}
							<span class="ap-profedit-row">
								<span class="signin-actions">
									<button class="ap-btn ap-btn-sm" type="button" disabled={!!passkeyUnavailable || !you || !connected || status === 'saving'} onclick={() => passkey('register')}>Add passkey</button>
									{#if snapshot.passkeySession}
										<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" disabled={!connected || status === 'saving'} onclick={() => passkey('logout')}>Sign out</button>
									{:else}
										<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" disabled={!!passkeyUnavailable || !connected || status === 'saving'} onclick={() => passkey('login')}>Sign in with passkey</button>
									{/if}
								</span>
								{#if passkeyError}
									<span class="ap-profedit-hint ap-profedit-err" role="alert">{passkeyError}</span>
								{:else if passkeyNotice}
									<span class="ap-profedit-hint ap-profedit-ok" role="status">{passkeyNotice}</span>
								{:else if passkeyUnavailable}
									<span class="ap-profedit-hint">{passkeyUnavailable}</span>
								{:else}
									<span class="ap-profedit-hint">{snapshot.passkeySession ? 'Signed in with a passkey' : 'Signed in as a guest'}</span>
								{/if}
							</span>
						{/if}
					</div>
				{/if}
				<div class="ap-profedit-actions">
					<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" disabled={status === 'saving'} onclick={close}>{status === 'altered' ? 'Close' : 'Cancel'}</button>
					<button class="ap-btn ap-btn-primary ap-btn-sm" type="submit" disabled={status === 'saving' || !draft.trim()}>{status === 'saving' ? 'Saving…' : 'Save'}</button>
				</div>
			</form>
		</div>
	{/if}
	<button class="ap-profile-me" class:ap-profile-open={open} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={`Your profile on ${backendLabel}: ${you?.name || you?.user_id || 'not signed in'}. Edit`} onclick={toggle}>
		<Avatar name={you?.name || you?.user_id || '?'} src={you?.avatar} />
		<span class="ap-profile-text">
			<span class="ap-profile-name">{you?.name || you?.user_id || 'Not signed in'}</span>
			<span class="ap-profile-sub">on {backendLabel}</span>
		</span>
		<span class="ap-profile-edit" aria-hidden="true">Edit</span>
	</button>
</div>

<style>
	.ap-profile-pop { max-height: calc(100dvh - 96px); overflow-y: auto; }
	.ap-profile-pop .ap-profedit-actions { flex-wrap: wrap; }
	.signin-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
