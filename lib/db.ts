import { neon } from '@neondatabase/serverless';

export type StoredArticle = {
  pmid: string;
  title: string;
  year: string;
  source: string;
  authors: string[];
  abstract: string | null;
  refs: string[];
  citedBy: string[];
  expanded: boolean;
  doi: string | null;
};

let cachedSql: ReturnType<typeof neon> | null = null;

export function getSql() {
  if (cachedSql) return cachedSql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add your Neon connection string to .env.local / Vercel env.');
  }
  cachedSql = neon(url);
  return cachedSql;
}

let schemaReady: Promise<void> | null = null;

async function runEnsureSchema(): Promise<void> {
  const sql = getSql();
  await sql`
    create table if not exists articles (
      pmid text primary key,
      title text not null default '',
      year text not null default '',
      source text not null default '',
      authors jsonb not null default '[]'::jsonb,
      abstract text,
      refs jsonb not null default '[]'::jsonb,
      cited_by jsonb not null default '[]'::jsonb,
      expanded boolean not null default false,
      doi text,
      updated_at timestamptz not null default now()
    )
  `;
  // Additive migrations for tables created before these columns existed.
  await sql`alter table articles add column if not exists doi text`;
  // Speeds up frontier sampling (un-expanded rows) and DOI lookups.
  await sql`create index if not exists articles_unexpanded_idx on articles (expanded) where not expanded`;
  await sql`create index if not exists articles_doi_idx on articles (doi) where doi is not null`;
}

/** Idempotent, memoised so concurrent requests only migrate once per process. */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) schemaReady = runEnsureSchema();
  return schemaReady;
}

type ArticleRow = {
  pmid: string;
  title: string;
  year: string;
  source: string;
  authors: unknown;
  abstract: string | null;
  refs: unknown;
  cited_by: unknown;
  expanded: boolean;
  doi: string | null;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function rowToArticle(row: ArticleRow): StoredArticle {
  return {
    pmid: row.pmid,
    title: row.title,
    year: row.year,
    source: row.source,
    authors: asStringArray(row.authors),
    abstract: row.abstract,
    refs: asStringArray(row.refs),
    citedBy: asStringArray(row.cited_by),
    expanded: row.expanded,
    doi: row.doi ?? null
  };
}

/** Loads stored rows for the given PMIDs (order not guaranteed). */
export async function getArticles(pmids: string[]): Promise<Map<string, StoredArticle>> {
  const result = new Map<string, StoredArticle>();
  const unique = Array.from(new Set(pmids.filter(Boolean)));
  if (unique.length === 0) return result;

  const sql = getSql();
  const rows = (await sql`
    select pmid, title, year, source, authors, abstract, refs, cited_by, expanded, doi
    from articles
    where pmid = any(${unique}::text[])
  `) as ArticleRow[];

  rows.forEach((row) => {
    const article = rowToArticle(row);
    result.set(article.pmid, article);
  });
  return result;
}

/**
 * Samples un-expanded "frontier" PMIDs — nodes we know about (a neighbour was
 * stored) but haven't crawled yet. Random sampling spreads the work so many
 * simultaneous visitors expand different parts of the graph.
 */
export async function getUnexpandedFrontier(limit: number): Promise<string[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    select pmid from articles
    where not expanded
    order by random()
    limit ${limit}
  `) as Array<{ pmid: string }>;
  return rows.map((row) => row.pmid);
}

/** Records a DOI → PMID mapping so future look-ups skip NCBI's esearch. */
export async function setArticleDoi(pmid: string, doi: string): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`
    insert into articles (pmid, doi) values (${pmid}, ${doi})
    on conflict (pmid) do update set doi = coalesce(articles.doi, excluded.doi)
  `;
}

/** Cached DOI → PMID lookup so a repeated DOI never re-hits NCBI's esearch. */
export async function getPmidByDoi(doi: string): Promise<string | null> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    select pmid from articles where lower(doi) = lower(${doi}) limit 1
  `) as Array<{ pmid: string }>;
  return rows[0]?.pmid ?? null;
}

/** Totals for the "you're helping grow the shared graph" stat. */
export async function getStats(): Promise<{ total: number; expanded: number }> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    select count(*)::int as total, count(*) filter (where expanded)::int as expanded from articles
  `) as Array<{ total: number; expanded: number }>;
  return { total: rows[0]?.total ?? 0, expanded: rows[0]?.expanded ?? 0 };
}

/**
 * Inserts a light-weight neighbour row (title/year only) without clobbering a
 * fully-expanded row that may already exist.
 */
export async function upsertStub(article: {
  pmid: string;
  title: string;
  year: string;
  source: string;
  authors: string[];
  doi?: string | null;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into articles (pmid, title, year, source, authors, doi)
    values (${article.pmid}, ${article.title}, ${article.year}, ${article.source}, ${JSON.stringify(article.authors)}::jsonb, ${article.doi ?? null})
    on conflict (pmid) do update set
      title = case when articles.title = '' or articles.title like 'PMID %' then excluded.title else articles.title end,
      year = case when articles.year = '' then excluded.year else articles.year end,
      source = case when articles.source = '' then excluded.source else articles.source end,
      authors = case when articles.authors = '[]'::jsonb then excluded.authors else articles.authors end,
      doi = coalesce(articles.doi, excluded.doi),
      updated_at = now()
  `;
}

/**
 * Writes a fully-resolved article (metadata + neighbours) and marks it expanded.
 * `abstract` may be null — used by the fast neighbourhood build, which skips
 * abstracts (they're fetched lazily on click). A null abstract never clobbers an
 * abstract already stored.
 */
export async function upsertArticle(article: {
  pmid: string;
  title: string;
  year: string;
  source: string;
  authors: string[];
  abstract: string | null;
  refs: string[];
  citedBy: string[];
  doi?: string | null;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into articles (pmid, title, year, source, authors, abstract, refs, cited_by, doi, expanded, updated_at)
    values (
      ${article.pmid}, ${article.title}, ${article.year}, ${article.source},
      ${JSON.stringify(article.authors)}::jsonb, ${article.abstract},
      ${JSON.stringify(article.refs)}::jsonb, ${JSON.stringify(article.citedBy)}::jsonb,
      ${article.doi ?? null}, true, now()
    )
    on conflict (pmid) do update set
      title = excluded.title,
      year = excluded.year,
      source = excluded.source,
      authors = excluded.authors,
      abstract = coalesce(excluded.abstract, articles.abstract),
      refs = excluded.refs,
      cited_by = excluded.cited_by,
      doi = coalesce(excluded.doi, articles.doi),
      expanded = true,
      updated_at = now()
  `;
}

/**
 * Bulk-upsert expanded articles (metadata + links, no abstract) in ONE round
 * trip via jsonb_to_recordset. Hundreds of sequential writes would otherwise
 * dominate a neighbourhood build. Caller must dedupe pmids within the batch.
 */
export async function bulkUpsertArticles(
  rows: Array<{
    pmid: string;
    title: string;
    year: string;
    source: string;
    authors: string[];
    refs: string[];
    citedBy: string[];
    doi?: string | null;
  }>
): Promise<void> {
  if (rows.length === 0) return;
  const sql = getSql();
  const payload = rows.map((r) => ({
    pmid: r.pmid,
    title: r.title,
    year: r.year,
    source: r.source,
    authors: r.authors,
    refs: r.refs,
    cited_by: r.citedBy,
    doi: r.doi ?? null
  }));
  await sql`
    insert into articles (pmid, title, year, source, authors, abstract, refs, cited_by, doi, expanded, updated_at)
    select x.pmid, x.title, x.year, x.source, x.authors, null, x.refs, x.cited_by, x.doi, true, now()
    from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
      as x(pmid text, title text, year text, source text, authors jsonb, refs jsonb, cited_by jsonb, doi text)
    on conflict (pmid) do update set
      title = excluded.title,
      year = excluded.year,
      source = excluded.source,
      authors = excluded.authors,
      abstract = coalesce(excluded.abstract, articles.abstract),
      refs = excluded.refs,
      cited_by = excluded.cited_by,
      doi = coalesce(excluded.doi, articles.doi),
      expanded = true,
      updated_at = now()
  `;
}

/** Bulk-upsert neighbour stubs (title only) in one round trip. */
export async function bulkUpsertStubs(
  rows: Array<{ pmid: string; title: string; year: string; source: string; authors: string[]; doi?: string | null }>
): Promise<void> {
  if (rows.length === 0) return;
  const sql = getSql();
  const payload = rows.map((r) => ({
    pmid: r.pmid,
    title: r.title,
    year: r.year,
    source: r.source,
    authors: r.authors,
    doi: r.doi ?? null
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
      doi = coalesce(articles.doi, excluded.doi),
      updated_at = now()
  `;
}
