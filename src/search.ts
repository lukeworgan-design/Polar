import { config } from './config';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export async function braveSearch(query: string, count: number = 5): Promise<BraveSearchResult[]> {
  const apiKey = config.braveSearchApiKey;
  if (!apiKey) {
    console.warn('BRAVE_SEARCH_API_KEY not set — skipping web search');
    return [];
  }

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', count.toString());

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

  return results.map((r: Record<string, unknown>) => ({
    title: (r['title'] as string) || '',
    url: (r['url'] as string) || '',
    description: (r['description'] as string) || '',
  }));
}

export function formatSearchResults(results: BraveSearchResult[]): string {
  if (results.length === 0) return 'No search results found.';
  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n${r.description}\n${r.url}`
  ).join('\n\n');
}
