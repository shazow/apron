/**
 * A Svelte action that gives each code block (`pre`) inside the node a Copy
 * button, such as for the bot token a `/invite-bot` notice carries. Pass the
 * rendered HTML as the parameter so blocks are found again when it changes.
 */
export function copyCode(node: HTMLElement, _html?: string): { update: (html?: string) => void; destroy: () => void } {
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const decorate = (): void => {
		for (const pre of node.querySelectorAll('pre')) {
			if (pre.querySelector(':scope > .ap-notice-copy')) continue;
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'ap-btn ap-btn-sm ap-notice-copy';
			button.textContent = 'Copy';
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				const text = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
				void navigator.clipboard?.writeText(text.replace(/\n$/, '')).then(
					() => (button.textContent = 'Copied'),
					() => (button.textContent = 'Copy failed')
				).finally(() => {
					const timer = setTimeout(() => {
						timers.delete(timer);
						button.textContent = 'Copy';
					}, 1500);
					timers.add(timer);
				});
			});
			pre.append(button);
		}
	};
	decorate();
	return {
		update: () => queueMicrotask(decorate),
		destroy: () => {
			for (const timer of timers) clearTimeout(timer);
		}
	};
}
