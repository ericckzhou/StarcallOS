import { describe, it, expect } from 'vitest';
import { htmlToText } from './html_text';

describe('htmlToText', () => {
  it('extracts the <title> and strips tags from the body', () => {
    const { title, text } = htmlToText('<html><head><title>My Page</title></head><body><p>Hello world</p></body></html>');
    expect(title).toBe('My Page');
    expect(text).toBe('Hello world');
  });

  it('falls back to the first <h1> when there is no <title>', () => {
    const { title } = htmlToText('<body><h1>Heading One</h1><h1>Second</h1></body>');
    expect(title).toBe('Heading One');
  });

  it('drops script, style, and comment content entirely', () => {
    const { text } = htmlToText(
      '<body><script>var x = 1;</script><style>.a{color:red}</style><!-- note --><p>Keep this</p></body>',
    );
    expect(text).toBe('Keep this');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('note');
  });

  it('decodes named and numeric entities', () => {
    const { text } = htmlToText('<p>Tom &amp; Jerry &mdash; 5 &lt; 10 &#38; more &#x41;</p>');
    expect(text).toBe('Tom & Jerry — 5 < 10 & more A');
  });

  it('preserves paragraph breaks as newlines and bullets list items', () => {
    const { text } = htmlToText('<div>One</div><div>Two</div><ul><li>a</li><li>b</li></ul>');
    expect(text).toContain('One\nTwo');
    expect(text).toContain('• a');
    expect(text).toContain('• b');
  });

  it('collapses runs of whitespace and trims', () => {
    const { text } = htmlToText('<p>   lots\t\t of    space\n\n\n\nhere   </p>');
    expect(text).toBe('lots of space\n\nhere');
  });

  it('handles empty and tagless input without throwing', () => {
    expect(htmlToText('').text).toBe('');
    expect(htmlToText('   ').text).toBe('');
    expect(htmlToText('just plain text').text).toBe('just plain text');
  });

  it('returns no title when none can be derived', () => {
    expect(htmlToText('<body><p>no headings</p></body>').title).toBeUndefined();
  });

  it('leaves an unknown entity untouched rather than dropping it', () => {
    expect(htmlToText('<p>a &bogus; b</p>').text).toBe('a &bogus; b');
  });
});
