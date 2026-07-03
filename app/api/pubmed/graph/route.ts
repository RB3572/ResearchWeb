import { NextRequest, NextResponse } from 'next/server';
import { cleanPmid } from '@/lib/ncbi';
import { getArticles, type StoredArticle } from '@/lib/db';
import { ingestNode } from '@/lib/ingest';

const MAX_NODES = 320;
// Cap how many *new* single-link leaves each node introduces so the graph reads
// as an interconnected web rather than dandelion rings. Cross-links to nodes
// already in the graph are always kept.
const NEW_LEAF_CAP = 8;

type GraphNode = {
  id: string;
  pmid: string;
  title: string;
  year: string;
  source: string;
  depth: number;
};

/**
 * Builds the graph by walking stored articles breadth-first from the seed.
 * Pure database reads — fast enough to fill the screen on load.
 */
async function readGraph(seed: string, depth: number) {
  const depthByPmid = new Map<string, number>([[seed, 0]]);
  const loaded = new Map<string, StoredArticle>();
  const linkKeys = new Set<string>();
  const links: Array<{ source: string; target: string }> = [];

  const addLink = (source: string, target: string) => {
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ source, target });
  };

  let frontier = [seed];

  for (let level = 0; level <= depth; level += 1) {
    const toLoad = frontier.filter((pmid) => !loaded.has(pmid));
    if (toLoad.length === 0) break;

    const rows = await getArticles(toLoad);
    const nextFrontier = new Set<string>();

    toLoad.forEach((pmid) => {
      const row = rows.get(pmid);
      if (!row) return;
      loaded.set(pmid, row);
      if (level >= depth) return; // don't expand beyond requested depth

      let newLeaves = 0;
      const consider = (neighborId: string, addLinkFn: () => void) => {
        addLinkFn();
        if (depthByPmid.has(neighborId)) {
          nextFrontier.add(neighborId); // existing node → keep the cross-link, traverse
          return;
        }
        if (newLeaves >= NEW_LEAF_CAP || depthByPmid.size >= MAX_NODES) return;
        newLeaves += 1;
        depthByPmid.set(neighborId, level + 1);
        nextFrontier.add(neighborId);
      };

      row.refs.forEach((refId) => consider(refId, () => addLink(pmid, refId)));
      row.citedBy.forEach((citeId) => consider(citeId, () => addLink(citeId, pmid)));
    });

    frontier = Array.from(nextFrontier);
  }

  // Resolve titles for every referenced node (leaves included).
  const missing = Array.from(depthByPmid.keys()).filter((pmid) => !loaded.has(pmid));
  if (missing.length > 0) {
    const extra = await getArticles(missing);
    extra.forEach((row, pmid) => loaded.set(pmid, row));
  }

  const nodes: GraphNode[] = [];
  loaded.forEach((row, pmid) => {
    if (!depthByPmid.has(pmid)) return;
    nodes.push({
      id: pmid,
      pmid,
      title: row.title,
      year: row.year,
      source: row.source,
      depth: depthByPmid.get(pmid) ?? 0
    });
  });

  const visible = new Set(nodes.map((node) => node.pmid));
  const prunedLinks = links.filter((link) => visible.has(link.source) && visible.has(link.target));

  return { nodes, links: prunedLinks };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const pmid = cleanPmid(searchParams.get('pmid'));
  const depthParam = Number.parseInt(searchParams.get('depth') || '3', 10);
  const depth = Math.min(Math.max(Number.isFinite(depthParam) ? depthParam : 3, 1), 4);

  if (!pmid) {
    return NextResponse.json({ error: 'A numeric pmid query parameter is required.' }, { status: 400 });
  }

  try {
    let seedRow = (await getArticles([pmid])).get(pmid);

    // Lazy first-touch: if the seed was never crawled, ingest a small
    // neighbourhood on demand so the graph is never empty.
    if (!seedRow?.expanded) {
      await ingestNode(pmid, true);
      seedRow = (await getArticles([pmid])).get(pmid);
    }

    const graph = await readGraph(pmid, depth);
    return NextResponse.json(graph, {
      headers: { 'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown graph error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
