import { NextRequest, NextResponse } from 'next/server';
import { cleanPmid } from '@/lib/ncbi';
import { crawl } from '@/lib/ingest';

// Long-running crawl — run against the local dev server (no serverless timeout).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const secret = process.env.INGEST_SECRET;
  const provided = searchParams.get('secret');
  // In production a secret is mandatory; in dev it's enforced only if configured.
  if (process.env.NODE_ENV === 'production' && !secret) {
    return NextResponse.json({ error: 'Ingest disabled: set INGEST_SECRET.' }, { status: 403 });
  }
  if (secret && provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pmid = cleanPmid(searchParams.get('pmid'));
  const depthParam = Number.parseInt(searchParams.get('depth') || '3', 10);
  const depth = Math.min(Math.max(Number.isFinite(depthParam) ? depthParam : 3, 1), 4);

  if (!pmid) {
    return NextResponse.json({ error: 'A numeric pmid query parameter is required.' }, { status: 400 });
  }

  try {
    const logs: string[] = [];
    const count = await crawl(pmid, depth, (message) => logs.push(message));
    return NextResponse.json({ seed: pmid, depth, expanded: count, logs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
