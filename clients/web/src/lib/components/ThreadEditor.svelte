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
	const initialTitle = untrack(() => thread.title ?? thread.thread_id);
	let title = $state(initialTitle);
	let text = $state(untrack(() => thread.summary ?? ''));
	let saving = $state(false);
	let error = $state<string | undefined>();

	/** Sends only what changed; the next `thread` frame is the truth, since a server may alter or decline. */
	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving || !enabled) return;
		saving = true;
		error = undefined;
		try {
			await client.updateThread(thread.room_id, thread.thread_id, {
				...(title.trim() !== initialTitle ? { title: title.trim() } : {}),
				summary: text.trim() ? text : ''
			}).promise;
			onclose();
		} catch (cause) {
			saving = false;
			error = cause instanceof Error ? cause.message : 'Unable to save thread';
		}
	}
</script>

<section class="ap-roomhead-pop" aria-label="Edit thread">
	<form class="ap-tedit" onsubmit={save}>
		<label class="ap-fieldlabel">Name
			<input class="ap-field" aria-label="Thread name" bind:value={title} disabled={saving} maxlength="120" />
		</label>
		<label class="ap-fieldlabel"><span class="ap-fieldlabel-row">Summary<span class="ap-fieldlabel-hint">Markdown</span></span>
			<textarea class="ap-field ap-field-multi" aria-label="Thread summary" bind:value={text} rows="6" disabled={saving} placeholder="What this thread settled. Lists, links and code are fine."></textarea>
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
