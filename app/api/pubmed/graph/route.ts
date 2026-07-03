import { NextRequest, NextResponse } from 'next/server';
import { cleanPmid, decodeEntities } from '@/lib/ncbi';
import { getArticles, type StoredArticle } from '@/lib/db';
import { expandNeighborhood, ingestNode } from '@/lib/ingest';

export const maxDuration = 60;

const MAX_NODES = 650;
// Cap how many *new* single-link leaves each node introduces so the graph reads
// as an interconnected web rather than dandelion rings. Cross-links to nodes
// already in the graph are always kept.
const NEW_LEAF_CAP = 11;

type GraphNode = {
  id: string;
  pmid: string;
  title: string;
  year: string;
  source: string;
  depth: number;
  expanded: boolean;
};

/**
 * Builds the graph by walking stored articles breadth-first from the seed.
 * Pure database reads — fast enough to fill the screen on load.
 */
async function readGraph(seed: string, depth: number, seedLeafCap: number) {
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
      // The focal paper may show its whole neighbourhood; deeper nodes are
      // capped so the web stays interconnected instead of sprouting rings.
      const leafCap = level === 0 ? seedLeafCap : NEW_LEAF_CAP;
      const consider = (neighborId: string, addLinkFn: () => void) => {
        addLinkFn();
        if (depthByPmid.has(neighborId)) {
          nextFrontier.add(neighborId); // existing node → keep the cross-link, traverse
          return;
        }
        if (newLeaves >= leafCap || depthByPmid.size >= MAX_NODES) return;
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
      title: decodeEntities(row.title),
      year: row.year,
      source: row.source,
      depth: depthByPmid.get(pmid) ?? 0,
      expanded: row.expanded
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
  const capParam = Number.parseInt(searchParams.get('cap') || '64', 10);
  const seedLeafCap = Math.min(Math.max(Number.isFinite(capParam) ? capParam : 64, 4), 64);
  // Seed loads (the home page / a pasted DOI) request depth 4 — build a rich,
  // saved 2-degree neighbourhood so the web isn't a lonely 30 nodes. Clicks
  // (depth ≤3) stay light: they only ingest the one node they touched.
  const build = searchParams.get('build') === '1' || depth >= 4;

  if (!pmid) {
    return NextResponse.json({ error: 'A numeric pmid query parameter is required.' }, { status: 400 });
  }

  try {
    let seedRow = (await getArticles([pmid])).get(pmid);

    if (build) {
      // Fast batched depth-2 build (idempotent — instant once cached in Neon).
      await expandNeighborhood(pmid);
    } else if (!seedRow?.expanded) {
      // Lazy first-touch so a clicked node is never empty.
      await ingestNode(pmid, true);
      seedRow = (await getArticles([pmid])).get(pmid);
    }

    const graph = await readGraph(pmid, depth, seedLeafCap);
    return NextResponse.json(graph, {
      headers: { 'Cache-Control': 'public, max-age=0, must-revalidate, s-maxage=3600' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown graph error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
