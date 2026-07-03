import { fetchAbstract, fetchLinksBatch, fetchSummaries } from '@/lib/ncbi';
import { ensureSchema, getArticles, upsertArticle, upsertStub } from '@/lib/db';

// Kept small: NCBI drops connections on large batched elink requests, and old
// papers have huge citation lists. These caps keep each node's neighbourhood
// focused and the crawl reliable.
const REF_CAP = 16;
const CITE_CAP = 16;
const MAX_NODES = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches one article's full record from NCBI (summary, abstract, references,
 * citations) and stores it, plus lightweight stubs for its neighbours so they
 * are renderable before being expanded themselves. Returns the neighbour PMIDs.
 */
export async function ingestNode(pmid: string, includeCitedBy = true): Promise<string[]> {
  const [summaries, abstract, refsMap, citesMap] = await Promise.all([
    fetchSummaries([pmid]),
    fetchAbstract(pmid),
    fetchLinksBatch([pmid], 'pubmed_pubmed_refs'),
    includeCitedBy ? fetchLinksBatch([pmid], 'pubmed_pubmed_citedin') : Promise.resolve(new Map<string, string[]>())
  ]);

  const self = summaries.get(pmid);
  const refs = (refsMap.get(pmid) || []).slice(0, REF_CAP);
  const citedBy = (citesMap.get(pmid) || []).slice(0, CITE_CAP);
  const neighborIds = Array.from(new Set([...refs, ...citedBy]));

  const neighborSummaries = await fetchSummaries(neighborIds);

  await upsertArticle({
    pmid,
    title: self?.title || `PMID ${pmid}`,
    year: self?.year || '',
    source: self?.source || '',
    authors: self?.authors || [],
    abstract,
    refs,
    citedBy
  });

  for (const neighborId of neighborIds) {
    const summary = neighborSummaries.get(neighborId);
    await upsertStub({
      pmid: neighborId,
      title: summary?.title || `PMID ${neighborId}`,
      year: summary?.year || '',
      source: summary?.source || '',
      authors: summary?.authors || []
    });
  }

  return neighborIds;
}

export type CrawlProgress = (message: string) => void;

/**
 * Breadth-first crawl outward from a seed to `depth` levels, expanding each
 * node exactly once. Slow by design (throttled) — meant to run offline so that
 * the live read endpoints only ever touch the database.
 */
export async function crawl(seed: string, depth = 3, onProgress?: CrawlProgress): Promise<number> {
  await ensureSchema();

  const scheduledDepth = new Map<string, number>([[seed, 0]]);
  const expanded = new Set<string>();
  let frontier = [seed];

  // Skip re-expanding nodes already stored from a previous crawl.
  const existing = await getArticles([seed]);
  if (existing.get(seed)?.expanded) {
    onProgress?.(`Seed ${seed} already ingested; refreshing neighbourhood.`);
  }

  for (let level = 0; level < depth; level += 1) {
    const nextFrontier = new Set<string>();

    for (const pmid of frontier) {
      if (expanded.has(pmid)) continue;
      if (expanded.size >= MAX_NODES) break;

      try {
        const neighbors = await ingestNode(pmid, level === 0);
        expanded.add(pmid);
        onProgress?.(`[depth ${level}] expanded ${pmid} (+${neighbors.length}) — ${expanded.size} total`);

        for (const neighborId of neighbors) {
          if (!scheduledDepth.has(neighborId)) {
            scheduledDepth.set(neighborId, level + 1);
            if (level + 1 < depth) nextFrontier.add(neighborId);
          }
        }
      } catch (error) {
        onProgress?.(`[depth ${level}] failed ${pmid}: ${error instanceof Error ? error.message : 'error'}`);
      }

      // Throttle to stay under NCBI's request-rate limits.
      await delay(process.env.NCBI_API_KEY ? 120 : 380);
    }

    frontier = Array.from(nextFrontier).slice(0, MAX_NODES - expanded.size);
    if (frontier.length === 0) break;
  }

  return expanded.size;
}
