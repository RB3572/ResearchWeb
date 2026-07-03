'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import DotField from './DotField';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false }) as any;

type PaperSummary = {
  pmid: string;
  title: string;
  year: string;
  source: string;
};

type ArticleDetail = PaperSummary & {
  authors: string[];
  abstract: string;
};

type ArticleResponse = {
  article: ArticleDetail;
  references: PaperSummary[];
  citedBy: PaperSummary[];
  error?: string;
};

type GraphNodeData = PaperSummary & { depth: number };

type GraphResponse = {
  nodes: GraphNodeData[];
  links: Array<{ source: string; target: string }>;
  error?: string;
};

type GraphNode = GraphNodeData & {
  id: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
};

type GraphLink = { source: string | GraphNode; target: string | GraphNode };

type ResearchWebGraphProps = {
  seedPmid: string;
};

// Monet "San Giorgio Maggiore at Dusk": dusk sun → water reflection.
const MONET_RAMP: Array<[number, number, number]> = [
  [255, 214, 138],
  [246, 158, 79],
  [227, 118, 78],
  [201, 91, 96],
  [140, 92, 148],
  [72, 112, 152],
  [32, 78, 112]
];

function rampColor(t: number, alpha = 1): string {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (MONET_RAMP.length - 1);
  const index = Math.floor(scaled);
  const frac = scaled - index;
  const a = MONET_RAMP[index];
  const b = MONET_RAMP[Math.min(index + 1, MONET_RAMP.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

export default function ResearchWebGraph({ seedPmid }: ResearchWebGraphProps) {
  const graphRef = useRef<any>(null);
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());
  const linksRef = useRef<Map<string, GraphLink>>(new Map());
  const degreeRef = useRef<Map<string, number>>(new Map());
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map());
  const detailsRef = useRef<Map<string, ArticleResponse>>(new Map());
  const pendingDetailRef = useRef<Map<string, Promise<ArticleResponse | null>>>(new Map());
  const expandedGraphRef = useRef<Set<string>>(new Set());
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const centerRef = useRef<{ x: number; y: number; maxR: number }>({ x: 0, y: 0, maxR: 1 });
  const didFitRef = useRef(false);

  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ArticleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rebuildIndexes = useCallback(() => {
    const degrees = new Map<string, number>();
    const neighbors = new Map<string, Set<string>>();
    linksRef.current.forEach((link) => {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      degrees.set(source, (degrees.get(source) || 0) + 1);
      degrees.set(target, (degrees.get(target) || 0) + 1);
      if (!neighbors.has(source)) neighbors.set(source, new Set());
      if (!neighbors.has(target)) neighbors.set(target, new Set());
      neighbors.get(source)?.add(target);
      neighbors.get(target)?.add(source);
    });
    degreeRef.current = degrees;
    neighborsRef.current = neighbors;
  }, []);

  const commitGraph = useCallback(() => {
    rebuildIndexes();
    setGraphData({
      nodes: Array.from(nodesRef.current.values()),
      links: Array.from(linksRef.current.values())
    });
  }, [rebuildIndexes]);

  const mergeGraph = useCallback(
    (data: GraphResponse, origin?: GraphNode) => {
      data.nodes.forEach((incoming) => {
        const existing = nodesRef.current.get(incoming.pmid);
        if (existing) {
          existing.title = incoming.title || existing.title;
          existing.year = incoming.year || existing.year;
          existing.source = incoming.source || existing.source;
          existing.depth = Math.min(existing.depth, incoming.depth);
        } else {
          const angle = Math.random() * Math.PI * 2;
          const distance = 30 + Math.random() * 50;
          nodesRef.current.set(incoming.pmid, {
            ...incoming,
            id: incoming.pmid,
            x: (origin?.x ?? 0) + Math.cos(angle) * distance,
            y: (origin?.y ?? 0) + Math.sin(angle) * distance
          } as GraphNode);
        }
      });

      data.links.forEach((link) => {
        const key = link.source < link.target ? `${link.source}|${link.target}` : `${link.target}|${link.source}`;
        if (!linksRef.current.has(key)) {
          linksRef.current.set(key, { source: link.source, target: link.target });
        }
      });

      commitGraph();
    },
    [commitGraph]
  );

  const fetchDetail = useCallback((pmid: string): Promise<ArticleResponse | null> => {
    const cached = detailsRef.current.get(pmid);
    if (cached) return Promise.resolve(cached);
    const pending = pendingDetailRef.current.get(pmid);
    if (pending) return pending;

    const request = (async () => {
      try {
        const response = await fetch(`/api/pubmed/article?pmid=${pmid}`);
        const data = (await response.json()) as ArticleResponse;
        if (!response.ok || data.error) throw new Error(data.error || `Could not load PMID ${pmid}`);
        detailsRef.current.set(pmid, data);
        return data;
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : 'Could not reach PubMed.');
        return null;
      } finally {
        pendingDetailRef.current.delete(pmid);
      }
    })();

    pendingDetailRef.current.set(pmid, request);
    return request;
  }, []);

  const expandGraphFrom = useCallback(
    async (pmid: string) => {
      if (expandedGraphRef.current.has(pmid)) return;
      expandedGraphRef.current.add(pmid);
      try {
        const response = await fetch(`/api/pubmed/graph?pmid=${pmid}&depth=2`);
        const data = (await response.json()) as GraphResponse;
        if (!response.ok || data.error) return;
        mergeGraph(data, nodesRef.current.get(pmid));
      } catch {
        expandedGraphRef.current.delete(pmid);
      }
    },
    [mergeGraph]
  );

  // Initial load: pull the seed's whole neighbourhood so the screen is full.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/pubmed/graph?pmid=${seedPmid}&depth=3`);
        const data = (await response.json()) as GraphResponse;
        if (cancelled) return;
        if (!response.ok || data.error) throw new Error(data.error || 'Could not build the graph.');
        expandedGraphRef.current.add(seedPmid);
        mergeGraph(data);
        // Re-fit a few times as the force layout settles so the web lands
        // centered and filling the viewport.
        [900, 2200, 4000, 6200].forEach((wait) => {
          window.setTimeout(() => {
            if (!cancelled) graphRef.current?.zoomToFit(600, 55);
          }, wait);
        });
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : 'Could not build the graph.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seedPmid, mergeGraph]);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // Tighten the force layout toward an Obsidian-like density.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || graphData.nodes.length === 0) return;
    graph.d3Force('charge')?.strength(-95).distanceMax(420);
    graph.d3Force('link')?.distance(36).strength(0.82);
    graph.d3Force('center')?.strength(0.045);
  }, [graphData.nodes.length]);

  const selectArticle = useCallback(
    (pmid: string) => {
      setSelectedId(pmid);
      selectedRef.current = pmid;
      setSelectedDetail(detailsRef.current.get(pmid) || null);
      void fetchDetail(pmid).then((detail) => {
        if (detail && selectedRef.current === pmid) setSelectedDetail(detail);
      });
      void expandGraphFrom(pmid);

      const node = nodesRef.current.get(pmid);
      if (node && graphRef.current && typeof node.x === 'number' && typeof node.y === 'number') {
        graphRef.current.centerAt(node.x, node.y, 600);
      }
    },
    [fetchDetail, expandGraphFrom]
  );

  const nodeColor = useCallback((node: GraphNode) => {
    const { x, y, maxR } = centerRef.current;
    const dist = Math.hypot((node.x || 0) - x, (node.y || 0) - y);
    return rampColor(dist / maxR);
  }, []);

  const drawNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const hoveredId = hoverRef.current;
      const currentSelectedId = selectedRef.current;
      const isHovered = node.id === hoveredId;
      const isSelected = node.id === currentSelectedId;
      const isNeighborOfHover = hoveredId ? neighborsRef.current.get(hoveredId)?.has(node.id) : false;
      const dimmed = Boolean(hoveredId) && !isHovered && !isNeighborOfHover && !isSelected;

      const degree = degreeRef.current.get(node.id) || 0;
      const baseRadius = 2.4 + Math.min(6.5, Math.sqrt(degree) * 1.2);
      const radius = isHovered ? baseRadius * 1.4 : baseRadius;
      const x = node.x || 0;
      const y = node.y || 0;
      const color = nodeColor(node);

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.28 : 1;

      if (isSelected || isHovered) {
        const glow = ctx.createRadialGradient(x, y, radius * 0.4, x, y, radius * 4.5);
        glow.addColorStop(0, rampColor(isSelected ? 0.05 : 0.2, 0.4));
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, radius * 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = isSelected ? '#fff2d6' : color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = 'rgba(255, 240, 210, 0.9)';
        ctx.lineWidth = 1.4 / globalScale;
        ctx.stroke();
      }

      const showLabel = isHovered || isSelected || globalScale > 2.4;
      if (showLabel && !dimmed) {
        const maxChars = isHovered || isSelected ? 62 : 34;
        const label = node.title.length > maxChars ? `${node.title.slice(0, maxChars - 1).trim()}…` : node.title;
        const fontSize = 11.5 / globalScale;
        ctx.font = `${isHovered || isSelected ? 500 : 400} ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle =
          isHovered || isSelected ? 'rgba(245, 236, 220, 0.94)' : 'rgba(224, 214, 196, 0.5)';
        ctx.fillText(label, x, y + radius + 4 / globalScale);
      }

      ctx.restore();
    },
    [nodeColor]
  );

  const drawPointerArea = useCallback((node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
    const degree = degreeRef.current.get(node.id) || 0;
    const radius = 2.4 + Math.min(6.5, Math.sqrt(degree) * 1.2) + 5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x || 0, node.y || 0, radius, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const updateCentroid = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.size === 0) return;
    let sumX = 0;
    let sumY = 0;
    nodes.forEach((node) => {
      sumX += node.x || 0;
      sumY += node.y || 0;
    });
    const cx = sumX / nodes.size;
    const cy = sumY / nodes.size;
    let maxR = 1;
    nodes.forEach((node) => {
      const dist = Math.hypot((node.x || 0) - cx, (node.y || 0) - cy);
      if (dist > maxR) maxR = dist;
    });
    centerRef.current = { x: cx, y: cy, maxR };
  }, []);

  const linkColor = useCallback((link: GraphLink) => {
    const hoveredId = hoverRef.current;
    const currentSelectedId = selectedRef.current;
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (hoveredId && (source === hoveredId || target === hoveredId)) return 'rgba(245, 210, 150, 0.55)';
    if (currentSelectedId && (source === currentSelectedId || target === currentSelectedId))
      return 'rgba(255, 226, 170, 0.5)';
    if (hoveredId) return 'rgba(180, 150, 120, 0.05)';
    return 'rgba(198, 168, 138, 0.22)';
  }, []);

  const linkWidth = useCallback((link: GraphLink) => {
    const hoveredId = hoverRef.current;
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    return hoveredId && (source === hoveredId || target === hoveredId) ? 1.3 : 0.55;
  }, []);

  const referenceRow = (paper: PaperSummary) => (
    <li key={paper.pmid}>
      <button className="paper-row" onClick={() => selectArticle(paper.pmid)}>
        <span className="paper-row-title">{paper.title}</span>
        <span className="paper-row-meta">
          {paper.year}
          {paper.source ? ` · ${paper.source}` : ''}
        </span>
      </button>
    </li>
  );

  const selectedNode = selectedId ? nodesRef.current.get(selectedId) || null : null;

  return (
    <main className="shell">
      <DotField />

      <div className="graph-layer">
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={drawPointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          autoPauseRedraw={false}
          d3AlphaDecay={0.028}
          d3VelocityDecay={0.42}
          warmupTicks={60}
          cooldownTime={5000}
          onRenderFramePre={updateCentroid}
          onNodeHover={(node: GraphNode | null) => {
            hoverRef.current = node ? node.id : null;
            document.body.style.cursor = node ? 'pointer' : '';
          }}
          onNodeClick={(node: GraphNode) => selectArticle(node.id)}
          onNodeDragEnd={(node: GraphNode) => {
            node.fx = undefined;
            node.fy = undefined;
          }}
          onBackgroundClick={() => setSelectedId(null)}
          onEngineStop={() => {
            if (!didFitRef.current && graphRef.current && graphData.nodes.length > 0) {
              didFitRef.current = true;
              graphRef.current.zoomToFit(700, 90);
            }
          }}
        />
      </div>

      <header className="wordmark">research web</header>

      {loading ? (
        <div className="boot-state">
          <span className="boot-spinner" />
          building the research web…
        </div>
      ) : null}
      {error ? <div className="error-toast">{error}</div> : null}

      {selectedId && (selectedDetail || selectedNode) ? (
        <aside className="paper-card" role="dialog" aria-label="Article details">
          <div className="card-sheen" aria-hidden="true" />
          <button className="card-close" onClick={() => setSelectedId(null)} aria-label="Close">
            ×
          </button>

          <h2 className="card-title">{selectedDetail?.article.title || selectedNode?.title}</h2>
          <p className="card-meta">
            {[selectedDetail?.article.year || selectedNode?.year, selectedDetail?.article.source || selectedNode?.source]
              .filter(Boolean)
              .join(' · ')}
          </p>

          <div className="card-body">
            {selectedDetail ? (
              <>
                {selectedDetail.article.abstract ? (
                  <p className="card-abstract">{selectedDetail.article.abstract}</p>
                ) : (
                  <p className="card-abstract muted">No abstract available.</p>
                )}

                <h3 className="card-section">References ({selectedDetail.references.length})</h3>
                {selectedDetail.references.length > 0 ? (
                  <ul className="paper-list">{selectedDetail.references.map(referenceRow)}</ul>
                ) : (
                  <p className="card-empty">None indexed on PubMed.</p>
                )}

                <h3 className="card-section">Cited by ({selectedDetail.citedBy.length})</h3>
                {selectedDetail.citedBy.length > 0 ? (
                  <ul className="paper-list">{selectedDetail.citedBy.map(referenceRow)}</ul>
                ) : (
                  <p className="card-empty">None indexed on PubMed.</p>
                )}
              </>
            ) : (
              <p className="card-abstract muted">Loading…</p>
            )}
          </div>
        </aside>
      ) : null}
    </main>
  );
}
