import { NextRequest, NextResponse } from 'next/server';
import { getPmidByDoi, setArticleDoi } from '@/lib/db';

export const maxDuration = 30;

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

type ESearchResponse = {
  esearchresult?: {
    idlist?: string[];
  };
};

/** Accepts raw DOIs and doi.org URLs; returns a normalized DOI or null. */
function cleanDoi(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  return /^10\.\S+\/\S+$/.test(trimmed) ? trimmed : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const doi = cleanDoi(searchParams.get('doi'));

  if (!doi) {
    return NextResponse.json({ error: 'That does not look like a DOI (expected 10.xxxx/…).' }, { status: 400 });
  }

  try {
    // Database first: if anyone has ever loaded this DOI, we already know its
    // PMID — no NCBI round-trip needed.
    const cachedPmid = await getPmidByDoi(doi).catch(() => null);
    if (cachedPmid) {
      return NextResponse.json(
        { pmid: cachedPmid, doi, cached: true },
        { headers: { 'Cache-Control': 'public, max-age=0, must-revalidate, s-maxage=86400' } }
      );
    }

    const url = new URL(`${EUTILS_BASE}/esearch.fcgi`);
    url.searchParams.set('db', 'pubmed');
    url.searchParams.set('term', `"${doi}"[AID]`);
    url.searchParams.set('retmode', 'json');
    url.searchParams.set('tool', 'ResearchWeb');
    url.searchParams.set('email', 'sidshendrikar@gmail.com');
    if (process.env.NCBI_API_KEY) {
      url.searchParams.set('api_key', process.env.NCBI_API_KEY);
    }

    const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 } });
    if (!response.ok) {
      throw new Error(`NCBI request failed with status ${response.status}`);
    }

    const data = (await response.json()) as ESearchResponse;
    const pmid = data.esearchresult?.idlist?.[0];

    if (!pmid) {
      return NextResponse.json(
        { error: 'This DOI is not indexed in PubMed — only biomedical papers are available.' },
        { status: 404 }
      );
    }

    // Cache the mapping so this DOI never needs esearch again.
    await setArticleDoi(pmid, doi).catch(() => {});

    return NextResponse.json(
      { pmid, doi },
      { headers: { 'Cache-Control': 'public, max-age=0, must-revalidate, s-maxage=86400' } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not resolve the DOI.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
