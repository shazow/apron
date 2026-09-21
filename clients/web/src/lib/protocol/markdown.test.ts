import { describe, expect, it } from 'vitest';
import { mentionsHandle, renderMarkdown, type MentionPerson } from './markdown';

const room: MentionPerson[] = [
	{ id: 'alice', name: 'Alice Chen' },
	{ id: 'bob', name: 'Bob' },
	{ id: 'sam', name: 'Sam', me: true }
];

describe('mention chips', () => {
	it('chips a handle that matches a sender, by name or by id', () => {
		const html = renderMarkdown('Handing this to @Alice Chen and @bob.', room);
		expect(html).toContain('<span class="ap-mention" data-id="alice" title="alice">@Alice Chen</span>');
		expect(html).toContain('<span class="ap-mention" data-id="bob" title="bob">@bob</span>');
	});

	it('marks the viewer’s own chip so the row can ping', () => {
		expect(renderMarkdown('@sam can you look?', room)).toContain('class="ap-mention ap-mention-me"');
	});

	it('matches case-insensitively and keeps the writer’s spelling', () => {
		expect(renderMarkdown('@BOB ping', room)).toContain('>@BOB</span>');
	});

	it('takes the longest handle when one is a prefix of another', () => {
		const html = renderMarkdown('@Alice Chen', [{ id: 'alice2', name: 'Alice' }, ...room]);
		expect(html).toContain('data-id="alice"');
		expect(html).not.toContain('data-id="alice2"');
	});

	it('leaves partial words, unknown handles and emails alone', () => {
		const html = renderMarkdown('@bobby, @nobody and mail@bob today', room);
		expect(html).not.toContain('ap-mention');
	});

	it('leaves handles inside code and fenced blocks as code', () => {
		expect(renderMarkdown('`@bob` stays', room)).not.toContain('ap-mention');
		expect(renderMarkdown('```\n@bob\n```', room)).not.toContain('ap-mention');
	});

	it('never chips inside a tag or a URL', () => {
		const html = renderMarkdown('[@bob](https://example.com/@bob)', room);
		expect(html).toContain('href="https://example.com/@bob"');
		expect(html.match(/ap-mention/g)).toHaveLength(1);
	});

	it('matches a handle the renderer escapes', () => {
		const html = renderMarkdown('thanks @Ops & Co', [{ id: 'ops', name: 'Ops & Co' }]);
		expect(html).toContain('data-id="ops"');
		expect(html).toContain('>@Ops &amp; Co</span>');
	});

	it('renders without people, as before', () => {
		expect(renderMarkdown('@bob is here')).toBe('<p>@bob is here</p>\n');
	});
});

describe('mentionsHandle', () => {
	it('follows the same whole-word rule as the chips', () => {
		expect(mentionsHandle('ping @Sam now', ['Sam', 'sam'])).toBe(true);
		expect(mentionsHandle('ping @SAM', ['Sam'])).toBe(true);
		expect(mentionsHandle('ping @Samuel', ['Sam'])).toBe(false);
		expect(mentionsHandle('mail@sam', ['sam'])).toBe(false);
		expect(mentionsHandle('nothing here', ['sam'])).toBe(false);
		expect(mentionsHandle('@sam', [undefined, ''])).toBe(false);
	});
});
