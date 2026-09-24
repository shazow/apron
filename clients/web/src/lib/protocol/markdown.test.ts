import { describe, expect, it } from 'vitest';
import { mentionedIds, renderMarkdown, renderPlain, type MentionResolver } from './markdown';

const resolve: MentionResolver = (id) => {
	if (id === 'alice') return { kind: 'user', id, name: 'Alice Chen' };
	if (id === 'guest_1') return { kind: 'user', id, name: 'Sam', me: true };
	if (id === '@server') return { kind: 'user', id, name: 'Server' };
	if (id === 'ops') return { kind: 'room', id, title: 'Ops & Co' };
	return undefined;
};

describe('mentions (Appendix J.3)', () => {
	it('renders a known user_id with the latest name', () => {
		expect(renderMarkdown('Handing this to @alice.', resolve)).toBe('<p>Handing this to <span class="ap-mention" data-user-id="alice" title="@alice">@Alice Chen</span>.</p>\n');
	});

	it('marks the viewer’s own chip', () => {
		expect(renderMarkdown('@guest_1 can you look?', resolve)).toContain('class="ap-mention ap-mention-me" data-user-id="guest_1"');
	});

	it('links a room mention and escapes its title', () => {
		expect(renderMarkdown('see @ops', resolve)).toContain('<button type="button" class="ap-mention ap-mention-room" data-room-id="ops" title="Open Ops &amp; Co">Ops &amp; Co</button>');
	});

	it('takes a second @ for system identities and drops trailing dots and dashes', () => {
		expect(renderPlain('ask @@server-- now', resolve)).toBe('ask <span class="ap-mention" data-user-id="@server" title="@@server">@Server</span>-- now');
	});

	it('leaves unknown IDs, emails, and mentions inside code or links as written', () => {
		expect(renderMarkdown('@nobody and mail@alice.com', resolve)).not.toContain('ap-mention');
		expect(renderMarkdown('`@alice` stays', resolve)).not.toContain('ap-mention');
		expect(renderMarkdown('```\n@alice\n```', resolve)).not.toContain('ap-mention');
		const html = renderMarkdown('[@alice](https://example.com/@alice)', resolve);
		expect(html).toContain('href="https://example.com/@alice"');
		expect(html).not.toContain('ap-mention');
	});

	it('escapes plain bodies and renders without a resolver as before', () => {
		expect(renderPlain('<b>@alice</b>', resolve)).toBe('&lt;b&gt;<span class="ap-mention" data-user-id="alice" title="@alice">@Alice Chen</span>&lt;/b&gt;');
		expect(renderMarkdown('@alice is here')).toBe('<p>@alice is here</p>\n');
	});

	it('lists mentioned IDs outside code', () => {
		expect(mentionedIds('@alice, `@bob` and @carol.', true)).toEqual(['alice', 'carol']);
		expect(mentionedIds('@alice, `@bob`', false)).toEqual(['alice', 'bob']);
	});
});

describe('line breaks', () => {
	it('keeps a typed line break inside a paragraph, and paragraphs apart', () => {
		expect(renderMarkdown('Deploy plan\nWe cut at 14:00')).toBe('<p>Deploy plan<br />We cut at 14:00</p>\n');
		expect(renderMarkdown('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>\n');
		expect(renderMarkdown('```\na\nb\n```')).toBe('<pre><code>a\nb\n</code></pre>\n');
	});
});
