# ResearchWeb

ResearchWeb is a minimal PubMed reference graph. It starts from a seed article and renders each paper as a node. Clicking a node opens a small paper panel and expands that paper's references into new connected nodes.

Seed PMID: `41817805`

## What it does

- Starts from one PubMed article.
- Fetches PubMed metadata and reference links through a Next.js API route.
- Renders a 3D force-directed graph inspired by `vasturiano/3d-force-graph`.
- Treats each paper as one node.
- Treats each reference as a connected node.
- Expands recursively when a node is clicked.
- Shows a minimal paper panel with the paper title and references.
- Applies a focus/blur treatment so the active node and its immediate neighborhood stay visually dominant.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Build

```bash
npm run build
npm start
```

## Deploying on Vercel

This repository is set up as a standard Next.js app. Import the repository into Vercel and deploy with the default settings.

Optional environment variable:

```bash
NEXT_PUBLIC_SEED_PMID=41817805
```

## Structure

```text
app/
  api/pubmed/article/route.ts   PubMed metadata and reference API
  globals.css                   Minimal graph UI styling
  layout.tsx                    App layout
  page.tsx                      Home page
components/
  ResearchWebGraph.tsx          3D graph interface
```

## Notes

The app does not currently need Neon. The graph is fetched live and cached through the Next.js API route. Database storage can be added later for saved graphs, annotations, user collections, and precomputed reference trees.
