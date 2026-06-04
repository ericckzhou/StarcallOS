import { describe, it, expect } from 'vitest';
import { extractArticle } from './readability';

// A realistic-ish page: site chrome (nav/footer/share) wrapping a real article.
const ARTICLE_PAGE = `<!DOCTYPE html><html><head><title>How LLMs Work</title></head>
<body>
  <nav><a href="/">Home</a><a href="/signup">Sign up</a><a href="/app">Get app</a> Listen Share</nav>
  <header>Sitemap Open in app Sign in</header>
  <article>
    <h1>How Large Language Models Work</h1>
    <p>Thanks to large language models, artificial intelligence has caught the attention of everyone. This paragraph is long enough that Readability treats it as real article content rather than boilerplate, which is the whole point of using it here.</p>
    <p>A second substantial paragraph continues the explanation so that the extracted article body is unmistakably the main content and not a stray sentence lost among navigation links and sign-up prompts.</p>
  </article>
  <footer>Sign up Sign in Get app Write Search Help Status</footer>
</body></html>`;

describe('extractArticle', () => {
  it('keeps the article body and drops nav/footer chrome', () => {
    const { text } = extractArticle(ARTICLE_PAGE);
    expect(text).toContain('artificial intelligence has caught the attention');
    expect(text).toContain('second substantial paragraph');
    // The sign-up / app chrome should not survive into the extracted text.
    expect(text).not.toMatch(/Get app/);
    expect(text).not.toMatch(/Sitemap/);
  });

  it('extracts the document title', () => {
    const { title } = extractArticle(ARTICLE_PAGE);
    expect(title).toBeTruthy();
    expect(title).toMatch(/How.*Large Language Models|How LLMs Work/i);
  });

  it('falls back to the plain stripper when there is no article to find', () => {
    // No prose Readability can latch onto — should still return the visible text
    // via the htmlToText fallback rather than an empty string.
    const { text } = extractArticle('<body><div>just a bare snippet of text</div></body>');
    expect(text).toContain('just a bare snippet of text');
  });

  it('does not throw on empty or tagless input', () => {
    expect(() => extractArticle('')).not.toThrow();
    expect(extractArticle('').text).toBe('');
    expect(extractArticle('plain words with no tags at all').text).toContain('plain words with no tags');
  });
});
