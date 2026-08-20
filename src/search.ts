import { config } from './config';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export async function braveSearch(
  query: string,
  count: number = 5,
  opts?: { freshness?: string },
): Promise<BraveSearchResult[]> {
  const apiKey = config.braveSearchApiKey;
  if (!apiKey) {
    console.warn('BRAVE_SEARCH_API_KEY not set — skipping web search');
    return [];
  }

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', count.toString());
  url.searchParams.set('extra_snippets', 'true'); // more text per result — better chance of catching dates
  if (opts?.freshness) url.searchParams.set('freshness', opts.freshness);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    console.error('Brave Search API error:', response.status, response.statusText);
    return [];
  }

  const data = await response.json() as Record<string, unknown>;
  const webResults = (data?.web as Record<string, unknown>)?.results;
  const results = Array.isArray(webResults) ? webResults : [];

  return results.map((r: Record<string, unknown>) => {
    const extra = Array.isArray(r['extra_snippets']) ? (r['extra_snippets'] as string[]).join(' | ') : '';
    const desc = (r['description'] as string) || '';
    return {
      title: (r['title'] as string) || '',
      url: (r['url'] as string) || '',
      description: [desc, extra].filter(Boolean).join(' — '),
    };
  });
}

/** Fetch a page and return a cleaned plain-text excerpt (best-effort, short timeout). */
export async function fetchPageText(url: string, maxChars: number = 4000): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RoseFamilyBot/1.0)' },
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

export function formatSearchResults(results: BraveSearchResult[]): string {
  if (results.length === 0) return 'No search results found.';
  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n${r.description}\n${r.url}`
  ).join('\n\n');
}
