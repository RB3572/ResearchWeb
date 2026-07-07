// Standalone frontier crawler for the scheduled job (GitHub Actions).
//
// Talks directly to Neon + NCBI with no serverless time limit, so the shared
// graph keeps growing without touching Vercel functions (Hobby-tier friendly).
// Expands CRAWL_NODES un-processed frontier articles per run, storing BOTH
// references and citations. Mirrors lib/ingest.ts `batchExpand`.
//
//   DATABASE_URL   Neon pooled connection string   (required)
//   NCBI_API_KEY   raises NCBI's rate limit 3→10/s (optional)
//   CRAWL_NODES    how many nodes to expand per run (default 40)
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const NCBI_API_KEY = process.env.NCBI_API_KEY || '';
const TARGET = Math.max(1, Number.parseInt(process.env.CRAWL_NODES || '40', 10) || 40);
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const REF_CAP = 16;
const CITE_CAP = 16;
const ELINK_CHUNK = 5;
const ELINK_CITE_CHUNK = 3;

const sql = neon(DATABASE_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

function codePointToChar(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 0x10ffff) return ' ';
  const char = String.fromCodePoint(codePoint);
  return /\s/u.test(char) || (codePoint >= 0x2000 && codePoint <= 0x200f) ? ' ' : char;
}
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointToChar(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePointToChar(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;|&thinsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
const stripTags = (v) => decodeEntities(v.replace(/<[^>]+>/g, ''));

async function eutils(path, params, retmode = 'json') {
  const url = new URL(`${EUTILS}/${path}`);
  const all = { tool: 'ResearchWeb', email: 'sidshendrikar@gmail.com', retmode, ...params };
  Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v));
  if (NCBI_API_KEY) url.searchParams.set('api_key', NCBI_API_KEY);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return retmode === 'json' ? res.json() : res.text();
      if (res.status !== 429 && res.status < 500) break;
    } catch {
      // retry
    }
    await sleep(350 * (attempt + 1));
  }
  throw new Error(`NCBI ${path} failed`);
}

function extractDoi(record) {
  const fromIds = record?.articleids?.find((a) => a.idtype === 'doi')?.value;
  if (fromIds) return fromIds.trim().toLowerCase();
  const fromEloc = record?.elocationid?.match(/10\.\S+\/\S+/)?.[0];
  return fromEloc ? fromEloc.trim().toLowerCase() : null;
}

async function fetchSummaries(ids) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const out = new Map();
  for (const group of chunk(unique, 180)) {
    const data = await eutils('esummary.fcgi', { db: 'pubmed', id: group.join(',') });
    for (const id of group) {
      const r = data.result?.[id];
      const pubdate = r?.pubdate || r?.epubdate || '';
      out.set(id, {
        title: stripTags(r?.title || `PMID ${id}`).replace(/\.$/, ''),
        year: pubdate.match(/\d{4}/)?.[0] || '',
        source: r?.fulljournalname || r?.source || '',
        authors: (r?.authors || []).map((a) => a.name).filter(Boolean).slice(0, 6),
        doi: extractDoi(r)
      });
    }
    await sleep(NCBI_API_KEY ? 40 : 120);
  }
  return out;
}

async function fetchLinksBatch(ids, linkname) {
  const result = new Map();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return result;
  const url = new URL(`${EUTILS}/elink.fcgi`);
  url.searchParams.set('dbfrom', 'pubmed');
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('cmd', 'neighbor');
  url.searchParams.set('linkname', linkname);
  url.searchParams.set('retmode', 'json');
  url.searchParams.set('tool', 'ResearchWeb');
  url.searchParams.set('email', 'sidshendrikar@gmail.com');
  unique.forEach((id) => url.searchParams.append('id', id));
  if (NCBI_API_KEY) url.searchParams.set('api_key', NCBI_API_KEY);

  let data = null;
  for (let attempt = 0; attempt < 4 && !data; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) { data = await res.json(); break; }
      if (res.status !== 429 && res.status < 500) break;
    } catch {
      // retry
    }
    await sleep(350 * (attempt + 1));
  }
  data?.linksets?.forEach((ls) => {
    const source = ls.ids?.[0];
    if (!source) return;
    const links = ls.linksetdbs?.flatMap((db) => (db.linkname === linkname ? db.links || [] : [])) || [];
    result.set(source, Array.from(new Set(links.filter((id) => id !== source))));
  });
  return result;
}

async function getFrontier(limit) {
  const rows = await sql`select pmid from articles where not expanded order by random() limit ${limit}`;
  return rows.map((r) => r.pmid);
}

async function bulkUpsertArticles(rows) {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    pmid: r.pmid, title: r.title, year: r.year, source: r.source,
    authors: r.authors, refs: r.refs, cited_by: r.citedBy, doi: r.doi ?? null
  }));
  await sql`
    insert into articles (pmid, title, year, source, authors, abstract, refs, cited_by, doi, expanded, updated_at)
    select x.pmid, x.title, x.year, x.source, x.authors, null, x.refs, x.cited_by, x.doi, true, now()
    from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
      as x(pmid text, title text, year text, source text, authors jsonb, refs jsonb, cited_by jsonb, doi text)
    on conflict (pmid) do update set
      title = excluded.title, year = excluded.year, source = excluded.source, authors = excluded.authors,
      abstract = coalesce(excluded.abstract, articles.abstract),
      refs = excluded.refs, cited_by = excluded.cited_by,
      doi = coalesce(excluded.doi, articles.doi), expanded = true, updated_at = now()
  `;
}

async function bulkUpsertStubs(rows) {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    pmid: r.pmid, title: r.title, year: r.year, source: r.source, authors: r.authors, doi: r.doi ?? null
  }));
  await sql`
    insert into articles (pmid, title, year, source, authors, doi)
    select x.pmid, x.title, x.year, x.source, coalesce(x.authors, '[]'::jsonb), x.doi
    from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
      as x(pmid text, title text, year text, source text, authors jsonb, doi text)
    on conflict (pmid) do update set
      title = case when articles.title = '' or articles.title like 'PMID %' then excluded.title else articles.title end,
      year = case when articles.year = '' then excluded.year else articles.year end,
      source = case when articles.source = '' then excluded.source else articles.source end,
      authors = case when articles.authors = '[]'::jsonb then excluded.authors else articles.authors end,
      doi = coalesce(articles.doi, excluded.doi), updated_at = now()
  `;
}

async function batchExpand(targets) {
  const ids = Array.from(new Set(targets.filter(Boolean)));
  if (ids.length === 0) return;

  const refsMap = new Map();
  const citesMap = new Map();
  for (const group of chunk(ids, ELINK_CHUNK)) {
    (await fetchLinksBatch(group, 'pubmed_pubmed_refs')).forEach((v, k) => refsMap.set(k, v));
    await sleep(NCBI_API_KEY ? 60 : 160);
  }
  for (const group of chunk(ids, ELINK_CITE_CHUNK)) {
    (await fetchLinksBatch(group, 'pubmed_pubmed_citedin')).forEach((v, k) => citesMap.set(k, v));
    await sleep(NCBI_API_KEY ? 60 : 160);
  }

  const perNode = new Map();
  const allIds = new Set(ids);
  for (const id of ids) {
    const refs = (refsMap.get(id) || []).filter((x) => x !== id).slice(0, REF_CAP);
    const citedBy = (citesMap.get(id) || []).filter((x) => x !== id).slice(0, CITE_CAP);
    perNode.set(id, { refs, citedBy });
    [...refs, ...citedBy].forEach((x) => allIds.add(x));
  }

  const summaries = await fetchSummaries(Array.from(allIds));
  const expandedSet = new Set(ids);

  await bulkUpsertArticles(
    ids.map((id) => {
      const s = summaries.get(id);
      const { refs, citedBy } = perNode.get(id) || { refs: [], citedBy: [] };
      return {
        pmid: id, title: s?.title || `PMID ${id}`, year: s?.year || '', source: s?.source || '',
        authors: s?.authors || [], refs, citedBy, doi: s?.doi ?? null
      };
    })
  );
  await bulkUpsertStubs(
    Array.from(allIds).filter((id) => !expandedSet.has(id)).map((id) => {
      const s = summaries.get(id);
      return { pmid: id, title: s?.title || `PMID ${id}`, year: s?.year || '', source: s?.source || '', authors: s?.authors || [], doi: s?.doi ?? null };
    })
  );
}

// ---- run ----
const start = Date.now();
let expanded = 0;
while (expanded < TARGET) {
  const frontier = await getFrontier(Math.min(ELINK_CHUNK, TARGET - expanded));
  if (frontier.length === 0) {
    console.log('No unexpanded frontier left.');
    break;
  }
  try {
    await batchExpand(frontier);
    expanded += frontier.length;
    console.log(`expanded ${expanded}/${TARGET}`);
  } catch (e) {
    console.warn('batch failed, continuing:', e?.message || e);
  }
}
const [{ total }] = await sql`select count(*)::int total from articles`;
console.log(`Done: expanded ${expanded} nodes in ${((Date.now() - start) / 1000).toFixed(0)}s. DB now ${total} rows.`);
