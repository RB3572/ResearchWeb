const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export type PubMedSummary = {
  id: string;
  pmid: string;
  title: string;
  authors: string[];
  source: string;
  year: string;
};

type ESummaryAuthor = { name?: string };

type ESummaryRecord = {
  uid?: string;
  title?: string;
  authors?: ESummaryAuthor[];
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  epubdate?: string;
};

type ESummaryResponse = {
  result?: Record<string, ESummaryRecord | string[]> & { uids?: string[] };
};

type ELinkResponse = {
  linksets?: Array<{
    ids?: string[];
    linksetdbs?: Array<{
      linkname?: string;
      links?: string[];
    }>;
  }>;
};

export function cleanPmid(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d{1,12}$/.test(trimmed) ? trimmed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codePointToChar(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 0x10ffff) return ' ';
  // Map the many unicode space variants (thin space U+2009 etc.) to a plain space.
  const char = String.fromCodePoint(codePoint);
  return /\s/u.test(char) || (codePoint >= 0x2000 && codePoint <= 0x200f) ? ' ' : char;
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePointToChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePointToChar(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;|&thinsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''));
}

async function fetchEutils(path: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(`${EUTILS_BASE}/${path}`);
  Object.entries({ tool: 'ResearchWeb', email: 'sidshendrikar@gmail.com', ...params }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  if (process.env.NCBI_API_KEY) {
    url.searchParams.set('api_key', process.env.NCBI_API_KEY);
  }

  // NCBI throttles hard (3 req/s without a key); retry transient failures with backoff.
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 } });
      if (response.ok) return response;
      lastError = `status ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'network error';
    }
    await sleep(350 * (attempt + 1));
  }
  throw new Error(`NCBI request failed (${lastError})`);
}

async function fetchJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const response = await fetchEutils(path, { retmode: 'json', ...params });
  return response.json() as Promise<T>;
}

function normalizeSummary(id: string, record: ESummaryRecord | undefined): PubMedSummary {
  const pubdate = record?.pubdate || record?.epubdate || '';
  return {
    id,
    pmid: id,
    title: stripTags(record?.title || `PMID ${id}`).replace(/\.$/, ''),
    authors: (record?.authors || [])
      .map((author) => author.name)
      .filter((name): name is string => Boolean(name))
      .slice(0, 6),
    source: record?.fulljournalname || record?.source || '',
    year: pubdate.match(/\d{4}/)?.[0] || ''
  };
}

/** Batched esummary — resolves titles/years for many PMIDs across chunked requests. */
export async function fetchSummaries(ids: string[]): Promise<Map<string, PubMedSummary>> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  const summaries = new Map<string, PubMedSummary>();
  const chunkSize = 180;

  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const data = await fetchJson<ESummaryResponse>('esummary.fcgi', {
      db: 'pubmed',
      id: chunk.join(',')
    });
    chunk.forEach((id) => {
      summaries.set(id, normalizeSummary(id, data.result?.[id] as ESummaryRecord | undefined));
    });
  }

  return summaries;
}

/**
 * Batched elink — expands MANY source PMIDs in one request and returns a map of
 * sourcePmid -> linked PMIDs for the given linkname (e.g. references or citing papers).
 */
export async function fetchLinksBatch(
  ids: string[],
  linkname: 'pubmed_pubmed_refs' | 'pubmed_pubmed_citedin'
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return result;

  const url = new URL(`${EUTILS_BASE}/elink.fcgi`);
  url.searchParams.set('dbfrom', 'pubmed');
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('cmd', 'neighbor');
  url.searchParams.set('linkname', linkname);
  url.searchParams.set('retmode', 'json');
  url.searchParams.set('tool', 'ResearchWeb');
  url.searchParams.set('email', 'sidshendrikar@gmail.com');
  uniqueIds.forEach((id) => url.searchParams.append('id', id));
  if (process.env.NCBI_API_KEY) {
    url.searchParams.set('api_key', process.env.NCBI_API_KEY);
  }

  let data: ELinkResponse | null = null;
  for (let attempt = 0; attempt < 4 && !data; attempt += 1) {
    try {
      const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 } });
      if (response.ok) {
        data = (await response.json()) as ELinkResponse;
        break;
      }
      if (response.status !== 429 && response.status < 500) break;
    } catch {
      // retry
    }
    await sleep(350 * (attempt + 1));
  }

  data?.linksets?.forEach((linkSet) => {
    const source = linkSet.ids?.[0];
    if (!source) return;
    const links =
      linkSet.linksetdbs?.flatMap((linkSetDb) =>
        linkSetDb.linkname === linkname ? linkSetDb.links || [] : []
      ) || [];
    result.set(source, Array.from(new Set(links.filter((id) => id !== source))));
  });

  return result;
}

/** Fetches and flattens a PubMed abstract (structured sections joined). */
export async function fetchAbstract(pmid: string): Promise<string> {
  const response = await fetchEutils('efetch.fcgi', {
    db: 'pubmed',
    id: pmid,
    rettype: 'abstract',
    retmode: 'xml'
  });
  const xml = await response.text();

  const sections: string[] = [];
  const abstractPattern = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g;
  let match: RegExpExecArray | null;
  while ((match = abstractPattern.exec(xml)) !== null) {
    const label = match[1].match(/Label="([^"]*)"/)?.[1];
    const text = stripTags(match[2]);
    if (!text) continue;
    sections.push(label ? `${label}: ${text}` : text);
  }
  return sections.join('\n\n');
}
