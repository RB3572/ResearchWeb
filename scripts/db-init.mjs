import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env.local first.');
  process.exit(1);
}

const sql = neon(url);

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
await sql`alter table articles add column if not exists doi text`;
await sql`create index if not exists articles_unexpanded_idx on articles (expanded) where not expanded`;
await sql`create index if not exists articles_doi_idx on articles (doi) where doi is not null`;

const [{ count }] = await sql`select count(*)::int as count from articles`;
console.log(`Schema ready. articles table has ${count} rows.`);
