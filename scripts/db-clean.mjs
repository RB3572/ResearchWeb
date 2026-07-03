// Scrubs HTML entity artifacts (&#x2009; etc.) out of already-stored rows.
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = neon(url);

function codePointToChar(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 0x10ffff) return ' ';
  const char = String.fromCodePoint(codePoint);
  return /\s/u.test(char) || (codePoint >= 0x2000 && codePoint <= 0x200f) ? ' ' : char;
}

function decodeLine(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePointToChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePointToChar(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;|&thinsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

function decodeText(value) {
  return value
    .split('\n\n')
    .map((paragraph) => decodeLine(paragraph))
    .filter(Boolean)
    .join('\n\n');
}

const rows = await sql`
  select pmid, title, abstract from articles
  where title like '%&%' or abstract like '%&%'
`;

console.log(`Found ${rows.length} rows with entity artifacts.`);
let updated = 0;

for (const row of rows) {
  const title = decodeText(row.title || '');
  const abstract = row.abstract ? decodeText(row.abstract) : row.abstract;
  if (title !== row.title || abstract !== row.abstract) {
    await sql`update articles set title = ${title}, abstract = ${abstract} where pmid = ${row.pmid}`;
    updated += 1;
  }
}

console.log(`Cleaned ${updated} rows.`);
