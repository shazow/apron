<script lang="ts">
	import { isJsonObject } from '$lib/protocol/types';
	import type { ChatClient, OperationHandle } from '$lib/protocol/client';
	import { passkeyMessage } from '$lib/ui/connection';
	import { directory } from '$lib/ui/directory.svelte';
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
		/** Sign-in lives on the connect screen; this opens it with the handle typed here. */
		onsignin: (name?: string) => void;
	}
	let { client, session, backendLabel, displayName = $bindable(), passkeyUnavailable, onsignout, onsignin }: Props = $props();

	let open = $state(false);
	let draft = $state('');
	let status = $state<Status>('idle');
	let serverName = $state('');
	let declinedReason = $state('');
	/** The handle the editor opened with; a different draft is one the user chose. */
	let openedWith = $state('');
	let passkeyError = $state('');
	let passkeyNotice = $state('');
	let avatarStatus = $state<'idle' | 'uploading' | 'removing'>('idle');
	let avatarError = $state('');
	let avatarInput = $state<HTMLInputElement | undefined>();
	let you = $derived(session.you);
	let avatar = $derived(directory.avatar(you));
	/** Avatars are uploaded to room `@avatar` (Appendix J.4), which needs cap `embed:upload`. */
	let canUploadAvatar = $derived(session.snapshot.capabilities['embed:upload']);
	let snapshot = $derived(session.snapshot);
	let connected = $derived(snapshot.status === 'connected');
	let canUsePasskey = $derived(!!session.server?.auth.includes('webauthn'));
	function toggle(): void {
		if (open) {
			close();
			return;
		}
		draft = you?.name || displayName;
		openedWith = draft;
		status = 'idle';
		serverName = '';
		declinedReason = '';
		passkeyError = '';
		passkeyNotice = '';
		avatarError = '';
		open = true;
	}

	/** The server sets `avatar` and sends `user` once the image is written; `you` then carries it. */
	async function uploadAvatar(input: HTMLInputElement): Promise<void> {
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		avatarStatus = 'uploading';
		avatarError = '';
		try {
			await client.uploadAvatar(file);
		} catch (cause) {
			avatarError = cause instanceof Error ? cause.message : 'The avatar could not be uploaded';
		} finally {
			avatarStatus = 'idle';
		}
	}

	async function removeAvatar(): Promise<void> {
		avatarStatus = 'removing';
		avatarError = '';
		try {
			const kept = await client.updateProfile({ avatar: '' });
			if (kept.avatar) avatarError = 'The server kept your previous avatar.';
		} catch (cause) {
			avatarError = cause instanceof Error ? cause.message : 'The avatar could not be removed';
		} finally {
			avatarStatus = 'idle';
		}
	}

	function close(): void {
		open = false;
		status = 'idle';
	}

	/** A handle the user typed in the editor, as opposed to the one it opened with. */
	function chosenName(): string | undefined {
		const requested = draft.trim();
		return requested && requested !== openedWith.trim() ? requested : undefined;
	}

	/**
	 * Signing in happens on the connect screen, which carries a handle typed
	 * here along so it is applied once the passkey signs in.
	 */
	function signIn(): void {
		const chosen = chosenName();
		close();
		onsignin(chosen);
	}

	/** Account actions for a passkey session: another passkey for this identity, or signing out. */
	async function passkey(action: 'register' | 'logout'): Promise<void> {
		passkeyError = '';
		passkeyNotice = '';
		try {
			if (action === 'logout') {
				onsignout();
				await client.signOut();
				passkeyNotice = 'Signed out.';
			} else {
				await client.usePasskey('register');
				passkeyNotice = 'Passkey saved · this backend will ask your device next time';
			}
			resetDraft();
		} catch (cause) {
			passkeyError = passkeyMessage(cause);
		}
	}

	function resetDraft(): void {
		draft = you?.name || displayName;
		openedWith = draft;
		if (status === 'declined') status = 'idle';
	}

	/** Shows what the server kept for a `me` request carrying `requested`. */
	async function track(handle: OperationHandle, requested: string, closeWhenKept: boolean): Promise<void> {
		status = 'saving';
		declinedReason = '';
		try {
			const result = await handle.promise;
			const kept = isJsonObject(result.you) && typeof result.you.name === 'string' ? result.you.name : requested;
			if (kept === requested) {
				if (closeWhenKept) {
					close();
					return;
				}
				status = 'idle';
			} else {
				serverName = kept;
				status = 'altered';
			}
			draft = kept;
			openedWith = kept;
		} catch (cause) {
			declinedReason = cause instanceof Error ? cause.message : '';
			status = 'declined';
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
		void track(handle, requested, true);
	}
</script>

<div class="ap-profile">
	{#if open}
		<div class="ap-profile-pop" role="dialog" aria-label="Edit profile">
			<form class="ap-profedit" onsubmit={save}>
				<div class="ap-profedit-top">
					<Avatar name={draft || you?.user_id || '?'} id={you?.user_id} src={avatar} size="lg" />
					<div class="ap-profedit-av">
						{#if canUploadAvatar}
							<span class="ap-profedit-avbtns">
								<button class="ap-btn ap-btn-sm" type="button" data-testid="change-avatar" disabled={status === 'saving' || avatarStatus !== 'idle' || !connected} onclick={() => avatarInput?.click()}>
									{avatarStatus === 'uploading' ? 'Uploading…' : you?.avatar ? 'Change avatar' : 'Add avatar'}
								</button>
								{#if you?.avatar}
									<button class="ap-link ap-profedit-remove" type="button" data-testid="remove-avatar" disabled={avatarStatus !== 'idle' || !connected} onclick={removeAvatar}>Remove</button>
								{/if}
							</span>
							<input class="sr" type="file" accept="image/png,image/jpeg,image/gif,image/webp" tabindex="-1" aria-hidden="true" data-testid="avatar-input" bind:this={avatarInput} onchange={(event) => uploadAvatar(event.currentTarget)} />
						{:else if you?.avatar}
							<button class="ap-link ap-profedit-remove" type="button" disabled={avatarStatus !== 'idle' || !connected} onclick={removeAvatar}>Remove avatar</button>
						{:else}
							<span class="ap-profedit-hint">This backend doesn’t take uploads, so your avatar can’t be set here.</span>
						{/if}
						{#if avatarError}<span class="ap-profedit-hint ap-profedit-err" role="alert">{avatarError}</span>{/if}
					</div>
				</div>
				<label class="ap-fieldlabel">Handle
					<input class="ap-field" data-testid="display-name-input" bind:value={draft} disabled={status === 'saving'} maxlength="64" autocomplete="nickname" spellcheck="false" />
				</label>
				<p class="ap-profedit-hint">ID <code>{you?.user_id ?? '—'}</code> · set by the server, can’t be changed</p>
				{#if status === 'altered'}
					<p class="ap-profedit-note" role="status">The server saved your handle as “{serverName}”.</p>
				{:else if status === 'declined'}
					<p class="ap-profedit-note ap-profedit-err" role="alert">
						The server declined this handle{declinedReason ? ` (${declinedReason})` : ''}.
						{#if canUsePasskey && !snapshot.passkeySession}
							Sign in with a passkey and it’s applied once you’re signed in.
						{:else}
							Your old one is still in use.
						{/if}
					</p>
				{/if}
				{#if canUsePasskey}
					<div class="ap-profedit-signin" role="group" aria-label="Sign-in">
						<span class="ap-fieldlabel">Sign-in</span>
						{#if snapshot.authBusy}
							<span class="ap-profedit-hint" role="status"><TypingDots /> Confirm on your device…</span>
						{:else}
							<span class="ap-profedit-row">
								<span class="signin-actions">
									{#if snapshot.passkeySession}
										<button class="ap-btn ap-btn-sm" type="button" disabled={!!passkeyUnavailable || !you || !connected || status === 'saving'} onclick={() => passkey('register')}>Add passkey</button>
										<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" disabled={!connected || status === 'saving'} onclick={() => passkey('logout')}>Sign out</button>
									{:else}
										<button class="ap-btn ap-btn-sm" type="button" data-testid="profile-signin" disabled={!!passkeyUnavailable || status === 'saving'} onclick={signIn}>Sign in with a passkey</button>
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
		<Avatar name={you?.name || you?.user_id || '?'} id={you?.user_id} src={avatar} />
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
	.signin-actions { align-items: center; }
	.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
