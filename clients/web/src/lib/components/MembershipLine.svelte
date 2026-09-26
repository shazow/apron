<script lang="ts">
	import type { Identity } from '$lib/protocol/types';
	import { directory } from '$lib/ui/directory.svelte';
	import { membershipSummary } from '$lib/ui/membership';
	import { idDateTime, idIso, idTime } from '$lib/ui/time';

	/**
	 * Who joined and left the room between two other timeline items
	 * (PROTOCOL.md §4.3.2), netted out: "Ada and Bob joined · Carol left". The
	 * quietest system line: no avatar, no actions, and its time only on hover.
	 */
	let { joined, left, logId }: { joined: Identity[]; left: Identity[]; logId: string } = $props();

	/** A user as every other row renders them (§3.3), with the handle when someone else shows under the same name. */
	function label(user: Identity): string {
		const name = directory.name(user);
		return directory.sharesName(user) ? `${name} (@${directory.person(user)?.user_id ?? user.user_id})` : name;
	}

	let summary = $derived(membershipSummary(joined.map(label), left.map(label)));
	let time = $derived(idTime(logId));
</script>

<div data-timeline-item class="ap-msg ap-msg-system ap-msg-member" data-testid="membership-line" data-log-id={logId} title={summary.title}>
	<div class="ap-msg-system-body">{summary.text}</div>
	{#if time}<time class="ap-msg-system-time" datetime={idIso(logId)} title={idDateTime(logId)}>{time}</time>{/if}
</div>
