import { NextRequest, NextResponse } from 'next/server';
import { getStats, getUnexpandedFrontier } from '@/lib/db';
import { ingestNode } from '@/lib/ingest';

export const maxDuration = 60;

// Every page load calls this a few times: it expands un-crawled "frontier"
// articles so the shared Neon graph grows with usage. The more people visit,
// the deeper the cache becomes and the faster loads get for everyone.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requested = Number.parseInt(searchParams.get('n') || '2', 10);
  const count = Math.min(Math.max(Number.isFinite(requested) ? requested : 2, 1), 4);

  try {
    // Over-sample candidates so concurrent visitors are unlikely to collide.
    const candidates = await getUnexpandedFrontier(count * 6);
    let expanded = 0;

    for (const pmid of candidates) {
      if (expanded >= count) break;
      try {
        await ingestNode(pmid, true);
        expanded += 1;
      } catch {
        // NCBI hiccup — just move to the next candidate.
      }
    }

    const stats = await getStats().catch(() => null);
    return NextResponse.json(
      { expanded, ...(stats ? { total: stats.total, expandedTotal: stats.expanded } : {}) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Expansion failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
