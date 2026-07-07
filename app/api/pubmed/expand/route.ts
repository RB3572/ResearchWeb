import { NextRequest, NextResponse } from 'next/server';
import { getStats } from '@/lib/db';
import { expandFrontier } from '@/lib/ingest';

export const maxDuration = 60;

// Distributed background crawling. Every visitor's browser calls this
// continuously, so the shared Neon graph keeps growing at its unprocessed edges
// — each call batch-expands a few frontier articles (references AND citations).
// The more people are on the site, the faster the whole literature graph fills
// in and the faster future loads become for everyone.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const requested = Number.parseInt(searchParams.get('n') || '3', 10);
  const count = Math.min(Math.max(Number.isFinite(requested) ? requested : 3, 1), 6);

  try {
    const expanded = await expandFrontier(count);
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
