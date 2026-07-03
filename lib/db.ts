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

export async function ensureSchema(): Promise<void> {
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
      updated_at timestamptz not null default now()
    )
  `;
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
    expanded: row.expanded
  };
}

/** Loads stored rows for the given PMIDs (order not guaranteed). */
export async function getArticles(pmids: string[]): Promise<Map<string, StoredArticle>> {
  const result = new Map<string, StoredArticle>();
  const unique = Array.from(new Set(pmids.filter(Boolean)));
  if (unique.length === 0) return result;

  const sql = getSql();
  const rows = (await sql`
    select pmid, title, year, source, authors, abstract, refs, cited_by, expanded
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
 * Inserts a light-weight neighbour row (title/year only) without clobbering a
 * fully-expanded row that may already exist.
 */
export async function upsertStub(article: {
  pmid: string;
  title: string;
  year: string;
  source: string;
  authors: string[];
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into articles (pmid, title, year, source, authors)
    values (${article.pmid}, ${article.title}, ${article.year}, ${article.source}, ${JSON.stringify(article.authors)}::jsonb)
    on conflict (pmid) do update set
      title = case when articles.title = '' or articles.title like 'PMID %' then excluded.title else articles.title end,
      year = case when articles.year = '' then excluded.year else articles.year end,
      source = case when articles.source = '' then excluded.source else articles.source end,
      authors = case when articles.authors = '[]'::jsonb then excluded.authors else articles.authors end,
      updated_at = now()
  `;
}

/** Writes a fully-resolved article (metadata + neighbours + abstract) and marks it expanded. */
export async function upsertArticle(article: {
  pmid: string;
  title: string;
  year: string;
  source: string;
  authors: string[];
  abstract: string;
  refs: string[];
  citedBy: string[];
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into articles (pmid, title, year, source, authors, abstract, refs, cited_by, expanded, updated_at)
    values (
      ${article.pmid}, ${article.title}, ${article.year}, ${article.source},
      ${JSON.stringify(article.authors)}::jsonb, ${article.abstract},
      ${JSON.stringify(article.refs)}::jsonb, ${JSON.stringify(article.citedBy)}::jsonb,
      true, now()
    )
    on conflict (pmid) do update set
      title = excluded.title,
      year = excluded.year,
      source = excluded.source,
      authors = excluded.authors,
      abstract = excluded.abstract,
      refs = excluded.refs,
      cited_by = excluded.cited_by,
      expanded = true,
      updated_at = now()
  `;
}
