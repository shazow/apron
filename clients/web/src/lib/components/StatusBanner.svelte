<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** The dot's colour; every tone sits beside a word. */
		tone?: 'ok' | 'warn' | 'danger' | 'none';
		role?: 'status' | 'alert' | 'note';
		testid?: string;
		/** Announce text changes to assistive tech. */
		live?: boolean;
		children: Snippet;
		action?: Snippet;
	}
	let { tone = 'none', role = 'status', testid, live = false, children, action }: Props = $props();
</script>

<div class="ap-status" {role}>
	<span class="ap-status-dot" class:ap-status-ok={tone === 'ok'} class:ap-status-warn={tone === 'warn'} class:ap-status-danger={tone === 'danger'} aria-hidden="true"></span>
	<span class="ap-status-text" data-testid={testid} aria-live={live ? 'polite' : undefined}>{@render children()}</span>
	{@render action?.()}
</div>
