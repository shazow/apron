<script lang="ts">
	import type { MessageSelection } from '$lib/ui/selection.svelte';
	import type { ThreadEntry } from '$lib/ui/timeline';
	import TypingDots from './TypingDots.svelte';

	interface Props {
		selection: MessageSelection;
		/** Where the picked messages can go, besides a new thread; the open thread is left out. */
		threads: ThreadEntry[];
		/** In a thread, messages can also go back to the room. */
		inThread: boolean;
		onmove: (thread: string | null) => void;
		onnewthread: () => void;
		onfill: () => void;
		oncancel: () => void;
	}
	let { selection, threads, inThread, onmove, onnewthread, onfill, oncancel }: Props = $props();
	let current = $derived(selection.current);
	let count = $derived(current?.ids.length ?? 0);
	let hasMenu = $derived(threads.length > 0 || inThread);
</script>

{#if current}
	<div class="ap-selbar" role="toolbar" aria-label="Selected messages" data-testid="selection-bar">
		<span class="ap-selbar-info">
			<span class="ap-selbar-count">{count === 1 ? '1 message selected' : `${count} messages selected`}</span>
			{#if count > 1 && !current.saving}
				<button class="ap-link" type="button" onclick={onfill}>Select between</button>
			{/if}
			{#if current.denied}
				<span class="denied" role="alert">{current.denied.failed} of {current.denied.total} couldn’t be moved</span>
			{/if}
		</span>
		<span class="ap-selbar-actions">
			{#if current.saving}
				<span class="ap-selbar-status" role="status"><TypingDots /> Moving {count}…</span>
			{:else}
				<button class="ap-btn ap-btn-ghost ap-btn-sm" type="button" onclick={oncancel}>Cancel</button>
				{#if hasMenu}
					<span class="ap-selbar-pick">
						<button class="ap-btn ap-btn-sm" type="button" aria-haspopup="listbox" aria-expanded={selection.menuOpen} onclick={() => (selection.menuOpen = !selection.menuOpen)}>Move to thread ▾</button>
						{#if selection.menuOpen}
							<ul class="ap-menu" role="listbox" aria-label="Move to thread">
								{#if inThread}
									<li><button class="ap-menu-item" type="button" role="option" aria-selected="false" onclick={() => onmove(null)}>Move to room</button></li>
								{/if}
								{#each threads as thread (thread.thread_id)}
									<li><button class="ap-menu-item" type="button" role="option" aria-selected="false" onclick={() => onmove(thread.thread_id)}>{thread.title}</button></li>
								{/each}
							</ul>
						{/if}
					</span>
				{/if}
				<button class="ap-btn ap-btn-primary ap-btn-sm" type="button" data-testid="new-thread" onclick={onnewthread}>New thread</button>
			{/if}
		</span>
	</div>
{/if}

<style>
	.denied { color: var(--danger); }
</style>
