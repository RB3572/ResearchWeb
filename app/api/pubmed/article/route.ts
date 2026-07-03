import { NextRequest, NextResponse } from 'next/server';

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const DEFAULT_LIMIT = 28;
const MAX_LIMIT = 60;

type PubMedSummary = {
  id: string;
  pmid: string;
  title: string;
  authors: string[];
  source: string;
  pubdate: string;
  year: string;
  doi?: string;
};

type ESummaryAuthor = {
  name?: string;
};

type ESummaryArticleId = {
  idtype?: string;
  value?: string;
};

type ESummaryRecord = {
  uid?: string;
  title?: string;
  authors?: ESummaryAuthor[];
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  epubdate?: string;
  articleids?: ESummaryArticleId[];
};

type ESummaryResponse = {
  result?: Record<string, ESummaryRecord | string[]> & { uids?: string[] };
};

type ELinkResponse = {
  linksets?: Array<{
    linksetdbs?: Array<{
      links?: string[];
    }>;
  }>;
};

function cleanPmid(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d{1,12}$/.test(trimmed) ? trimmed : null;
}

function cleanLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSummary(id: string, record: ESummaryRecord | undefined): PubMedSummary {
  const title = decodeHtml(record?.title || `PMID ${id}`);
  const pubdate = record?.pubdate || record?.epubdate || '';
  const year = pubdate.match(/\d{4}/)?.[0] || '';
  const doi = record?.articleids?.find((articleId) => articleId.idtype === 'doi')?.value;

  return {
    id,
    pmid: id,
    title,
    authors: (record?.authors || [])
      .map((author) => author.name)
      .filter((name): name is string => Boolean(name))
      .slice(0, 8),
    source: record?.fulljournalname || record?.source || 'PubMed',
    pubdate,
    year,
    doi
  };
}

async function fetchJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${EUTILS_BASE}/${path}`);
  Object.entries({ tool: 'ResearchWeb', retmode: 'json', ...params }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    next: { revalidate: 60 * 60 * 24 },
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`NCBI request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchSummaries(ids: string[]): Promise<PubMedSummary[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const data = await fetchJson<ESummaryResponse>('esummary.fcgi', {
    db: 'pubmed',
    id: uniqueIds.join(',')
  });

  return uniqueIds.map((id) => normalizeSummary(id, data.result?.[id] as ESummaryRecord | undefined));
}

async function fetchReferenceIds(pmid: string, limit: number): Promise<string[]> {
  const data = await fetchJson<ELinkResponse>('elink.fcgi', {
    dbfrom: 'pubmed',
    db: 'pubmed',
    id: pmid,
    linkname: 'pubmed_pubmed_refs'
  });

  const ids =
    data.linksets?.flatMap((linkSet) =>
      linkSet.linksetdbs?.flatMap((linkSetDb) => linkSetDb.links || []) || []
    ) || [];

  return Array.from(new Set(ids.filter((id) => id !== pmid))).slice(0, limit);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const pmid = cleanPmid(searchParams.get('pmid'));
  const limit = cleanLimit(searchParams.get('limit'));

  if (!pmid) {
    return NextResponse.json({ error: 'A numeric pmid query parameter is required.' }, { status: 400 });
  }

  try {
    const [article] = await fetchSummaries([pmid]);
    const referenceIds = await fetchReferenceIds(pmid, limit);
    const references = await fetchSummaries(referenceIds);

    return NextResponse.json(
      {
        article,
        references,
        links: references.map((reference) => ({
          source: pmid,
          target: reference.pmid,
          type: 'reference'
        }))
      },
      {
        headers: {
          'Cache-Control': 's-maxage=86400, stale-while-revalidate=604800'
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown PubMed fetch error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
