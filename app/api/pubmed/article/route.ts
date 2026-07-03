import { NextRequest, NextResponse } from 'next/server';
import { cleanPmid, decodeEntities } from '@/lib/ncbi';
import { getArticles, type StoredArticle } from '@/lib/db';
import { ingestNode } from '@/lib/ingest';

export const maxDuration = 60;

type ListItem = { pmid: string; title: string; year: string; source: string };

function toListItem(article: StoredArticle): ListItem {
  return { pmid: article.pmid, title: decodeEntities(article.title), year: article.year, source: article.source };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const pmid = cleanPmid(searchParams.get('pmid'));

  if (!pmid) {
    return NextResponse.json({ error: 'A numeric pmid query parameter is required.' }, { status: 400 });
  }

  try {
    let article = (await getArticles([pmid])).get(pmid);

    // Expand on demand when a node hasn't been crawled yet (grows the web as
    // the user explores). Abstracts only exist on expanded rows.
    if (!article?.expanded) {
      await ingestNode(pmid, true);
      article = (await getArticles([pmid])).get(pmid);
    }

    if (!article) {
      return NextResponse.json({ error: `PMID ${pmid} not found.` }, { status: 404 });
    }

    const neighborIds = Array.from(new Set([...article.refs, ...article.citedBy]));
    const neighbors = await getArticles(neighborIds);
    const collect = (ids: string[]) =>
      ids.map((id) => neighbors.get(id)).filter((row): row is StoredArticle => Boolean(row)).map(toListItem);

    return NextResponse.json(
      {
        article: {
          pmid: article.pmid,
          title: decodeEntities(article.title),
          year: article.year,
          source: article.source,
          authors: article.authors,
          // Decode per paragraph so entity cleanup can't collapse section breaks.
          abstract: (article.abstract || '')
            .split('\n\n')
            .map((paragraph) => decodeEntities(paragraph))
            .filter(Boolean)
            .join('\n\n')
        },
        references: collect(article.refs),
        citedBy: collect(article.citedBy)
      },
      // max-age=0 keeps browsers revalidating (no stale disk-cache replays);
      // s-maxage still lets the CDN serve cached copies.
      { headers: { 'Cache-Control': 'public, max-age=0, must-revalidate, s-maxage=3600' } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown PubMed fetch error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
