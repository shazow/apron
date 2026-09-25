<script lang="ts">
	import { untrack } from 'svelte';
	import type { ChatClient } from '$lib/protocol/client';
	import type { ThreadEntry } from '$lib/ui/timeline';

	interface Props {
		client: ChatClient;
		thread: ThreadEntry;
		/** False while the session can't take requests; the form stays open but won't save. */
		enabled: boolean;
		onclose: () => void;
	}
	let { client, thread, enabled, onclose }: Props = $props();

	// The form starts from the thread as it was opened; the caller remounts it per thread.
	const initialTitle = untrack(() => thread.title);
	let title = $state(initialTitle);
	let saving = $state(false);
	let error = $state<string | undefined>();

	/**
	 * Saves the title with `room_set` (§4.3.4); the intro message and `ext`
	 * are resubmitted unchanged. The `room_update` that follows is the truth,
	 * since a server may alter or decline.
	 */
	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving || !enabled) return;
		const next = title.trim();
		if (next === initialTitle) {
			onclose();
			return;
		}
		saving = true;
		error = undefined;
		try {
			await client.updateRoom(thread.id, { title: next || null }).promise;
			onclose();
		} catch (cause) {
			saving = false;
			error = cause instanceof Error ? cause.message : 'Unable to save thread';
		}
	}
</script>

<section class="ap-roomhead-pop" aria-label="Edit thread">
	<form class="ap-tedit" onsubmit={save}>
		<label class="ap-fieldlabel">Title
			<input class="ap-field" aria-label="Thread title" bind:value={title} disabled={saving} maxlength="120" />
		</label>
		{#if error}<p class="ap-profedit-note ap-profedit-err" role="alert">{error}</p>{/if}
		<div class="ap-profedit-actions">
			<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" disabled={saving} onclick={onclose}>Cancel</button>
			<button class="ap-btn ap-btn-primary ap-btn-sm" type="submit" aria-label="Save thread" disabled={saving || !enabled}>{saving ? 'Saving…' : 'Save'}</button>
		</div>
	</form>
</section>

<style>
	@media (max-width: 719px) {
		.ap-roomhead-pop { left: var(--space-4); }
	}
</style>
