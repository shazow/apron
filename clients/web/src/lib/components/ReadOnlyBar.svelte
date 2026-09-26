<script lang="ts">
	/**
	 * Stands in for the composer while a guest only reads (the demo worker's
	 * `ext.demo.guest_posting: false`): says why, and offers the passkey
	 * sign-in that lifts it. Rooms can still be listed and read, without joining.
	 */
	interface Props {
		/** Why passkeys can't be used in this browser, when they can't. */
		passkeyUnavailable?: string;
		onsignin: () => void;
	}
	let { passkeyUnavailable, onsignin }: Props = $props();
</script>

<div class="ap-composer readonly" role="note" data-testid="read-only-bar">
	<p class="readonly-text">
		You’re reading as a guest. {passkeyUnavailable ? `Posting needs a passkey sign-in. ${passkeyUnavailable}` : 'Sign in to post, react, join rooms, and start threads.'}
	</p>
	{#if !passkeyUnavailable}
		<button class="ap-btn ap-btn-primary ap-btn-sm" type="button" data-testid="read-only-signin" onclick={onsignin}>Sign in</button>
	{/if}
</div>

<style>
	.readonly { align-items: center; }
	.readonly-text { flex: 1; margin: 0; padding: 3px var(--space-1); font-size: 14px; line-height: 20px; color: var(--ink-muted); }
</style>
