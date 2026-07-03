# ResearchWeb

An Obsidian‑style, interactive graph of biomedical research papers. It opens on a
seed article and renders its citation neighbourhood as a living, draggable web:
every node is a PubMed paper, every edge is a reference or a citation. Click a node
to read its abstract and jump to its references or the papers that cite it; the web
grows as you explore. Paste your own paper's DOI to grow a graph around it.

Live: **research-web.rishib.com** · Default seed PMID: `41817805`

The design goal is a calm, minimal, aesthetically‑pleasing surface — greyscale
background, colourful nodes, smooth un‑jittery physics, a liquid‑glass detail card,
and a dark/light toggle.

---

## Table of contents

- [How it works at a glance](#how-it-works-at-a-glance)
- [Architecture](#architecture)
- [Data model (Neon Postgres)](#data-model-neon-postgres)
- [The three layers](#the-three-layers)
- [API reference](#api-reference)
- [The graph front‑end](#the-graph-front-end)
- [Theming](#theming)
- [Shared, database‑centric growth](#shared-database-centric-growth)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Seeding / crawling the database](#seeding--crawling-the-database)
- [Deployment (Vercel + Neon)](#deployment-vercel--neon)
- [File map](#file-map)

---

## How it works at a glance

The browser **never waits on PubMed**. All reads go to a Neon Postgres database that
acts as a cache/mirror of PubMed. When the site loads it fetches a pre‑crawled
neighbourhood from Neon in ~50ms and renders the whole graph at once. Anything not
yet cached is fetched from NCBI **once**, stored in Neon, and served from the
database forever after. The more the site is used, the larger and faster it gets.

```
Browser ──▶ /api/pubmed/graph ──▶ Neon (instant)  ──┐
                                     │ cache miss?   │
                                     ▼               │
                              NCBI E‑utilities ──────┘  (fetch once, store)
```

---

## Architecture

- **Framework:** Next.js 14 (App Router) — static shell + serverless route handlers.
- **Database:** Neon serverless Postgres via `@neondatabase/serverless` (HTTP driver).
- **Data source:** NCBI E‑utilities (`esummary`, `elink`, `efetch`, `esearch`).
- **Rendering:** `react-force-graph-2d` on a 2D canvas, with all node/link painting
  done by hand for full control over colour, easing, and labels.
- **Hosting:** Vercel (frontend + serverless functions); Neon for data.

Why database‑first: NCBI E‑utilities is rate‑limited (~3 req/s without a key),
slow, and drops connections on large batched requests. Building a multi‑degree
graph live takes tens of seconds and is unreliable. Pre‑computing into Neon makes
reads instant and turns NCBI into a background, write‑only dependency.

---

## Data model (Neon Postgres)

A single table, `articles`, holds everything the app needs. Neighbours are stored
as arrays of PMIDs on each row (capped), so the graph is reconstructed by walking
rows — no join table.

| column       | type          | meaning                                                        |
|--------------|---------------|----------------------------------------------------------------|
| `pmid`       | `text` (PK)   | PubMed ID                                                      |
| `title`      | `text`        | Article title (HTML entities decoded)                         |
| `year`       | `text`        | Publication year                                              |
| `source`     | `text`        | Journal name                                                  |
| `authors`    | `jsonb`       | Up to 6 author names                                          |
| `abstract`   | `text`        | Flattened abstract (structured sections joined)              |
| `refs`       | `jsonb`       | PMIDs this paper **references** (capped ~16)                  |
| `cited_by`   | `jsonb`       | PMIDs that **cite** this paper (capped ~16)                   |
| `doi`        | `text`        | DOI, used for DOI→PMID cache lookups                          |
| `expanded`   | `boolean`     | `true` once the paper's own neighbourhood has been fetched   |
| `updated_at` | `timestamptz` | Last write                                                    |

Two partial indexes support the hot paths:

- `articles_unexpanded_idx on (expanded) where not expanded` — frontier sampling.
- `articles_doi_idx on (doi) where doi is not null` — DOI cache lookups.

**Stubs vs. expanded rows.** When a paper is crawled, its neighbours are inserted as
lightweight *stubs* (title/year/source only, `expanded = false`) so they are
immediately renderable. A stub becomes *expanded* when it is itself crawled and its
`refs`/`cited_by` get filled in. `upsertStub` never clobbers a richer expanded row.

The schema is created/migrated idempotently by `ensureSchema()` in
[`lib/db.ts`](lib/db.ts) (memoised per process) and by
[`scripts/db-init.mjs`](scripts/db-init.mjs).

---

## The three layers

### 1. Ingest (write) — [`lib/ncbi.ts`](lib/ncbi.ts), [`lib/ingest.ts`](lib/ingest.ts)

Talks to NCBI and writes to Neon. Key helpers:

- `fetchSummaries(ids)` — batched `esummary` (chunked ≤180 ids) → title/year/source/authors/doi.
- `fetchLinksBatch(ids, linkname)` — batched `elink` that expands **many** PMIDs in
  one request, returning `source → linked PMIDs`. This is the core efficiency trick;
  it is used with `pubmed_pubmed_refs` (references) and `pubmed_pubmed_citedin`
  (citations).
- `fetchAbstract(pmid)` — `efetch` XML, structured `AbstractText` sections flattened.
- `decodeEntities()` — decodes numeric/HTML entities (`&#x2009;` etc.) so abstracts
  read cleanly.

`ingestNode(pmid)` fetches one paper's summary + abstract + references + citations,
stores it (`expanded = true`), and stores stubs for its neighbours. `crawl(seed, depth)`
does a throttled breadth‑first crawl, reusing already‑expanded rows instead of
re‑hitting NCBI.

### 2. Read — [`app/api/pubmed/graph`](app/api/pubmed/graph/route.ts), [`app/api/pubmed/article`](app/api/pubmed/article/route.ts)

Pure database reads. The graph endpoint walks stored rows breadth‑first from a PMID
and returns `{ nodes, links }`. On a cache miss (seed never crawled) it lazily
ingests just that node, then reads — so the graph is never empty.

### 3. Render — [`components/ResearchWebGraph.tsx`](components/ResearchWebGraph.tsx)

Fetches the graph, runs the force layout, paints the canvas, and manages selection,
DOI input, theming, and background contribution.

---

## API reference

All endpoints live under `app/api/`.

### `GET /api/pubmed/graph?pmid=<id>&depth=<1..4>&cap=<n>`
Builds the neighbourhood graph around `pmid` by walking Neon rows to `depth` levels.
`cap` limits how many direct neighbours the focal node contributes (deeper levels
use a smaller fixed cap so the web stays interconnected rather than sprouting rings).
Returns `{ nodes: [{ id, pmid, title, year, source, depth, expanded }], links: [{ source, target }] }`.
Lazily ingests the seed if it isn't in the DB yet. Total nodes capped at 650.

### `GET /api/pubmed/article?pmid=<id>`
Returns one paper's full detail for the card: `{ article: { …, abstract }, references: [...], citedBy: [...] }`.
Lazily ingests on a miss. Titles/abstract are entity‑decoded at read time.

### `GET /api/pubmed/resolve?doi=<doi>`
Resolves a DOI (or a `doi.org` URL) to a PMID. **Checks Neon first** (`getPmidByDoi`)
and only falls back to NCBI `esearch` on a miss — then stores the mapping so it is
cached forever. Returns `{ pmid, doi, cached? }`.

### `GET /api/pubmed/expand?n=<1..4>`
The "help grow the shared graph" endpoint. Samples `n` random un‑expanded frontier
PMIDs from Neon and ingests them (server‑side), deepening the shared database.
Returns `{ expanded, total, expandedTotal }`. Every page load calls this a few times
in the background.

### `GET /api/admin/ingest?pmid=<id>&depth=<1..4>&secret=<INGEST_SECRET>`
Long‑running throttled crawl used for offline seeding. Guarded by `INGEST_SECRET`
(mandatory in production). Best run against the local dev server, which has no
serverless timeout. Returns `{ expanded, logs }`.

---

## The graph front‑end

[`components/ResearchWebGraph.tsx`](components/ResearchWebGraph.tsx) is the heart of the app.

### Layout & framing
- On load, the seed's 4‑degree neighbourhood (up to 650 nodes) is fetched and the
  nodes are spawned pre‑spread across a wide disk, then the force layout eases them
  into place.
- `frameGraph()` fits the whole web then zooms in so it spills past the viewport
  edges (harder in portrait so mobile fills top‑to‑bottom). It runs once after the
  layout settles and never fights the user once they interact.

### Calm, un‑jittery physics
The repeated design requirement was **no jitter / no sudden acceleration**. This is
achieved with three mechanisms:

1. **Soft, heavily‑damped forces** — low link‑spring strength (`0.3`) plus high
   velocity damping (`d3VelocityDecay = 0.62`). Motion is slow and never oscillates.
2. **Pinning on growth** — adding nodes normally reheats d3's simulation and jerks
   the whole layout. Instead, before every incremental merge the existing nodes are
   pinned at their current positions (`fx/fy`), so only the *new* nodes move — the web
   grows outward from a parent instead of reshuffling. (Verified: 0.00px movement of
   existing nodes across additions.) Pinning waits until the initial layout has
   spread (`seedSettledRef`) so it can't freeze a still‑collapsing seed.
3. **Freeze on drag** — the moment a drag begins, every other node is frozen in place,
   so nothing around the dragged node can vibrate; the node stays where it's dropped.

### Selection & exploration
Clicking a node (or a row in the card) opens the detail card, recenters, and expands
**≥3 degrees** out from that node (merged into the current web). A depth map
(`expandedDepthRef`) lets a click deepen a node that was only shallowly touched by
background auto‑expansion.

### Painting
Everything on the canvas is drawn by hand with per‑node / per‑link **eased** visual
state (alpha, scale, highlight, dim) advanced every frame — so hovers brighten/dim
with a smooth transition rather than a hard cut. Node size scales with degree.
Node **colour** uses a Monet "San Giorgio Maggiore at Dusk" ramp mapped by distance
from the graph centroid (warm gold at the core → cool blue at the rim). Node fills
stay colourful in both themes; only the neutral chrome (links, labels, selection
ring) flips for legibility.

### Canvas sizing gotcha
`react-force-graph`'s auto‑sizing occasionally measures the parent as `0×0` (e.g.
after a viewport change), leaving a blank canvas. The component passes **explicit**
`width`/`height` from a window‑resize‑tracked state to avoid this. The ref is wired
via `fgRef` because Next's `dynamic()` import doesn't forward a standard `ref`.

### Ambient layers (behind the graph)
- [`SvgBlobAnimation.tsx`](components/SvgBlobAnimation.tsx) — a few very slow, heavily
  blurred, **greyscale** blobs drifting behind everything (ambient light, not colour).
- [`DotField.tsx`](components/DotField.tsx) — a faint grid of grey dots that gently
  parts around the cursor and shimmers. Listens via capture‑phase `pointermove` so it
  keeps responding even while d3‑drag is swallowing events.
- A strong `edge-blur` + `edge-fade` ring gives the web a depth‑of‑field rim as it
  spills off‑screen.

### Loader
[`GraphLoader.tsx`](components/GraphLoader.tsx) shows [`SiriWave.tsx`](components/SiriWave.tsx)
— a self‑contained WebGL fragment shader (six warm‑tinted fluid‑dot metaballs that
merge and scatter) masked into a soft orb — while a graph builds. It holds for a
minimum of ~0.9s so fast cached loads don't flash.

---

## Theming

A **greyscale** background with **colourful nodes**, plus a dark/light toggle
(top‑right sun/moon button). The choice persists in `localStorage` and defaults to
the OS preference.

- CSS custom properties define both palettes in [`app/globals.css`](app/globals.css)
  under `:root[data-theme='dark']` / `:root[data-theme='light']`. The component sets
  `document.documentElement.dataset.theme`.
- The background gradient, blobs, dot field, links, labels, panels, and the DOI bar
  all switch. Node fills stay Monet; in light mode nodes get a thin dark outline to
  stay legible on white.
- Canvas‑drawn colours (nodes/links/labels/dots) read the theme through refs, so they
  update immediately when toggled.

---

## Shared, database‑centric growth

The database is the product. Every visitor helps it grow:

- **Seed & DOI loads** store whatever they touch.
- **Background contribution** — on each page load the client calls
  `/api/pubmed/expand` a few times (staggered, then every ~45s while the tab is
  visible). The server expands random un‑crawled frontier articles into Neon.
- **Foreground auto‑expansion** — the visible graph quietly deepens its own stubs.
- **DOI cache** — DOI→PMID mappings are stored, so a repeated DOI resolves from the
  database (~0.2s) instead of hitting NCBI (~2.5s).

Net effect: nothing already in the database is ever re‑fetched, and the graph gets
bigger and faster the more the site is used.

---

## Environment variables

Create `.env.local` (see [`.env.local.example`](.env.local.example)):

| variable        | required | purpose                                                                 |
|-----------------|----------|-------------------------------------------------------------------------|
| `DATABASE_URL`  | yes      | Neon **pooled** connection string (`postgresql://…?sslmode=require`).    |
| `INGEST_SECRET` | prod     | Guards `/api/admin/ingest`. Mandatory in production.                     |
| `NCBI_API_KEY`  | no       | Raises NCBI's rate limit from 3→10 req/s; makes crawls faster.           |

Set the same variables in the Vercel project's Environment Variables.

---

## Local development

```bash
npm install
cp .env.local.example .env.local   # then fill in DATABASE_URL
npm run db:init                    # create the table + indexes
npm run dev                        # http://localhost:3000
```

`npm run db:init` runs [`scripts/db-init.mjs`](scripts/db-init.mjs) to create/migrate
the schema. Other scripts: `npm run build`, `npm start`, `npm run lint`.

There is also [`scripts/db-clean.mjs`](scripts/db-clean.mjs) — a one‑off that scrubs
HTML‑entity artifacts out of any rows stored before entity decoding was added:

```bash
node --env-file=.env.local scripts/db-clean.mjs
```

---

## Seeding / crawling the database

For a rich first experience, pre‑crawl the seed's neighbourhood into Neon. Run this
against the **local** dev server (no serverless timeout):

```bash
# with the dev server running:
curl "http://localhost:3000/api/admin/ingest?pmid=41817805&depth=4&secret=$INGEST_SECRET"
```

The crawl is throttled to respect NCBI's limits and is idempotent (already‑expanded
nodes are reused). Depth 4 from the seed yields a few hundred interconnected papers.
After that, ordinary traffic keeps the database growing via `/api/pubmed/expand`.

---

## Deployment (Vercel + Neon)

1. Create a Neon project and copy the **pooled** connection string.
2. Import this repo into Vercel (framework preset: Next.js — see [`vercel.json`](vercel.json)).
3. Add `DATABASE_URL`, `INGEST_SECRET`, and optionally `NCBI_API_KEY` to Vercel env.
4. Deploy. Route handlers set `maxDuration` where a crawl might run long.
5. Optionally seed the database (see above) so the first visit is instant.

The default seed can be overridden with `NEXT_PUBLIC_SEED_PMID` (see
[`app/page.tsx`](app/page.tsx)).

---

## File map

```
app/
  page.tsx                     Seed PMID → <ResearchWebGraph/>
  layout.tsx                   Root layout + metadata
  globals.css                  Theme variables, greyscale bg, glass card, loader, layout
  api/pubmed/graph/route.ts    Graph read (BFS over Neon) + lazy ingest
  api/pubmed/article/route.ts  Article detail (abstract + refs + cited_by)
  api/pubmed/resolve/route.ts  DOI → PMID (DB‑cached, esearch fallback)
  api/pubmed/expand/route.ts   Shared background DB growth
  api/admin/ingest/route.ts    Guarded offline crawl
components/
  ResearchWebGraph.tsx         The graph: layout, physics, painting, selection, theme
  DotField.tsx                 Interactive greyscale dot‑grid background
  SvgBlobAnimation.tsx         Slow greyscale ambient blobs
  SiriWave.tsx                 Self‑contained WebGL fluid‑dots shader (loader)
  GraphLoader.tsx              Loader overlay wrapping SiriWave
lib/
  ncbi.ts                      NCBI E‑utilities client (batched, retrying, decoding)
  db.ts                        Neon client, schema, article/frontier/DOI queries
  ingest.ts                    ingestNode() + throttled crawl()
scripts/
  db-init.mjs                  Create/migrate schema
  db-clean.mjs                 Scrub legacy HTML‑entity artifacts
```
