import { fetchAbstract, fetchLinksBatch, fetchSummaries } from '@/lib/ncbi';
import {
  bulkUpsertArticles,
  bulkUpsertStubs,
  ensureSchema,
  getArticles,
  getUnexpandedFrontier,
  upsertArticle,
  upsertStub
} from '@/lib/db';

// Kept small: NCBI drops connections on large batched elink requests, and old
// papers have huge citation lists. These caps keep each node's neighbourhood
// focused and the crawl reliable.
const REF_CAP = 16;
const CITE_CAP = 16;
const MAX_NODES = 400;
// elink drops connections when too many ids are batched — keep chunks small.
// Citations (citedin) of old papers are enormous, so use an even smaller chunk.
const ELINK_CHUNK = 5;
const ELINK_CITE_CHUNK = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Structure-only expansion of a SET of articles in a handful of batched
 * requests, written in two bulk upserts. Each target becomes an EXPANDED row
 * (abstract skipped — fetched on click); their neighbours become stubs.
 *
 * `includeCitedBy` controls whether citations are fetched. Citations of old
 * papers are huge and slow, so the time-sensitive seed build leaves it off
 * (the seed itself still has both directions from its full ingest), while the
 * background frontier crawl turns it on to accumulate both edge directions
 * across the whole graph over time.
 */
async function batchExpand(ids: string[], includeCitedBy: boolean): Promise<void> {
  const targets = Array.from(new Set(ids.filter(Boolean)));
  if (targets.length === 0) return;

  const refsMap = new Map<string, string[]>();
  const citesMap = new Map<string, string[]>();

  for (const group of chunk(targets, ELINK_CHUNK)) {
    const refs = await fetchLinksBatch(group, 'pubmed_pubmed_refs');
    refs.forEach((value, key) => refsMap.set(key, value));
    await delay(process.env.NCBI_API_KEY ? 60 : 160);
  }
  if (includeCitedBy) {
    for (const group of chunk(targets, ELINK_CITE_CHUNK)) {
      const cites = await fetchLinksBatch(group, 'pubmed_pubmed_citedin');
      cites.forEach((value, key) => citesMap.set(key, value));
      await delay(process.env.NCBI_API_KEY ? 60 : 160);
    }
  }

  const perNode = new Map<string, { refs: string[]; citedBy: string[] }>();
  const allIds = new Set<string>(targets);
  for (const id of targets) {
    const refs = (refsMap.get(id) || []).filter((x) => x !== id).slice(0, REF_CAP);
    const citedBy = (citesMap.get(id) || []).filter((x) => x !== id).slice(0, CITE_CAP);
    perNode.set(id, { refs, citedBy });
    [...refs, ...citedBy].forEach((x) => allIds.add(x));
  }

  const summaries = await fetchSummaries(Array.from(allIds));
  const expandedSet = new Set(targets);

  await bulkUpsertArticles(
    targets.map((id) => {
      const self = summaries.get(id);
      const { refs, citedBy } = perNode.get(id) || { refs: [], citedBy: [] };
      return {
        pmid: id,
        title: self?.title || `PMID ${id}`,
        year: self?.year || '',
        source: self?.source || '',
        authors: self?.authors || [],
        refs,
        citedBy,
        doi: self?.doi ?? null
      };
    })
  );

  await bulkUpsertStubs(
    Array.from(allIds)
      .filter((id) => !expandedSet.has(id))
      .map((id) => {
        const summary = summaries.get(id);
        return {
          pmid: id,
          title: summary?.title || `PMID ${id}`,
          year: summary?.year || '',
          source: summary?.source || '',
          authors: summary?.authors || [],
          doi: summary?.doi ?? null
        };
      })
  );
}

/**
 * Distributed background crawling: expand a few random un-processed frontier
 * articles (with both refs + citations). Called continuously by every visitor's
 * browser via /api/pubmed/expand, so the shared Neon graph keeps growing at its
 * edges. Returns how many nodes were expanded.
 */
export async function expandFrontier(count = 3): Promise<number> {
  await ensureSchema();
  const candidates = await getUnexpandedFrontier(count * 4);
  const targets = candidates.slice(0, count);
  if (targets.length === 0) return 0;
  // Background crawl: fetch BOTH directions so the shared graph accumulates
  // references and citations everywhere over time.
  await batchExpand(targets, true);
  return targets.length;
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
    citedBy,
    doi: self?.doi ?? null
  });

  for (const neighborId of neighborIds) {
    const summary = neighborSummaries.get(neighborId);
    await upsertStub({
      pmid: neighborId,
      title: summary?.title || `PMID ${neighborId}`,
      year: summary?.year || '',
      source: summary?.source || '',
      authors: summary?.authors || [],
      doi: summary?.doi ?? null
    });
  }

  return neighborIds;
}

/**
 * Fast, structure-only expansion of a seed's neighbourhood to depth 2. Batches
 * elink/esummary across all neighbours and skips abstracts (fetched on click) —
 * so a fresh DOI produces a rich, saved web (with BOTH reference and citation
 * edges) in a handful of requests. Idempotent: neighbours already expanded are
 * left untouched. Returns the number of nodes expanded.
 */
export async function expandNeighborhood(seed: string, maxNeighbors = 24): Promise<number> {
  await ensureSchema();

  // Make sure the seed itself is expanded (full ingest, with abstract + both
  // references and citations).
  let seedRow = (await getArticles([seed])).get(seed);
  if (!seedRow?.expanded) {
    await ingestNode(seed, true);
    seedRow = (await getArticles([seed])).get(seed);
  }
  if (!seedRow) return 0;

  const neighbours = Array.from(new Set([...seedRow.refs, ...seedRow.citedBy])).slice(0, maxNeighbors);
  const existing = await getArticles(neighbours);
  const toExpand = neighbours.filter((id) => !existing.get(id)?.expanded);
  if (toExpand.length === 0) return 0;

  // Refs-only here so the seed build stays under the serverless time limit; the
  // seed itself already connects both its references and its citers (from its
  // full ingest), and the background crawl fills citations in everywhere else.
  await batchExpand(toExpand, false);
  return toExpand.length;
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
    // Nodes already expanded in a previous crawl keep their stored neighbours —
    // reuse them instead of re-hitting NCBI.
    const storedRows = await getArticles(frontier);

    for (const pmid of frontier) {
      if (expanded.has(pmid)) continue;
      if (expanded.size >= MAX_NODES) break;

      let neighbors: string[] = [];
      const stored = storedRows.get(pmid);

      if (stored?.expanded) {
        neighbors = Array.from(new Set([...stored.refs, ...stored.citedBy]));
        expanded.add(pmid);
      } else {
        try {
          neighbors = await ingestNode(pmid, level === 0);
          expanded.add(pmid);
          onProgress?.(`[depth ${level}] expanded ${pmid} (+${neighbors.length}) — ${expanded.size} total`);
        } catch (error) {
          onProgress?.(`[depth ${level}] failed ${pmid}: ${error instanceof Error ? error.message : 'error'}`);
        }
        // Throttle to stay under NCBI's request-rate limits.
        await delay(process.env.NCBI_API_KEY ? 120 : 380);
      }

      for (const neighborId of neighbors) {
        if (!scheduledDepth.has(neighborId)) {
          scheduledDepth.set(neighborId, level + 1);
          if (level + 1 < depth) nextFrontier.add(neighborId);
        }
      }
    }

    frontier = Array.from(nextFrontier).slice(0, MAX_NODES - expanded.size);
    if (frontier.length === 0) break;
  }

  return expanded.size;
}
