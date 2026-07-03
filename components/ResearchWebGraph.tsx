'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false }) as any;

const REFERENCE_LIMIT = 5;
const RENDER_DEGREES = 5;
const MAX_AUTO_FETCHES_PER_FOCUS = 90;

type PubMedArticle = {
  id: string;
  pmid: string;
  title: string;
  authors: string[];
  source: string;
  pubdate: string;
  year: string;
  doi?: string;
};

type PaperNode = PubMedArticle & {
  depth: number;
  isSeed?: boolean;
  expanded?: boolean;
  loading?: boolean;
  failed?: boolean;
  val: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

type PaperLink = {
  source: string | PaperNode;
  target: string | PaperNode;
  type: 'reference';
};

type GraphData = {
  nodes: PaperNode[];
  links: PaperLink[];
};

type PubMedArticleResponse = {
  article: PubMedArticle;
  references: PubMedArticle[];
  links: Array<{ source: string; target: string; type: 'reference' }>;
  error?: string;
};

type ResearchWebGraphProps = {
  seedPmid: string;
};

function makeSeedNode(seedPmid: string): PaperNode {
  return {
    id: seedPmid,
    pmid: seedPmid,
    title: `PMID ${seedPmid}`,
    authors: [],
    source: 'PubMed',
    pubdate: '',
    year: '',
    depth: 0,
    isSeed: true,
    expanded: false,
    loading: true,
    failed: false,
    val: 12,
    x: 0,
    y: 0
  };
}

function linkEndpointId(endpoint: string | PaperNode) {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

function shortTitle(title: string, max = 54) {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1).trim()}…`;
}

function getOutgoingReferenceIds(links: Map<string, PaperLink>, pmid: string) {
  const ids: string[] = [];
  links.forEach((link) => {
    if (linkEndpointId(link.source) === pmid) ids.push(linkEndpointId(link.target));
  });
  return ids.slice(0, REFERENCE_LIMIT);
}

function buildNeighborhood(graphData: GraphData, centerId: string | null) {
  if (!centerId) {
    const allDepths = new Map(graphData.nodes.map((node) => [node.id, 0]));
    return { data: graphData, depthById: allDepths };
  }

  const nodeById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();

  graphData.links.forEach((link) => {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    if (!adjacency.has(source)) adjacency.set(source, []);
    adjacency.get(source)?.push(target);
  });

  const depthById = new Map<string, number>([[centerId, 0]]);
  const queue = [{ id: centerId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= RENDER_DEGREES) continue;

    const nextIds = (adjacency.get(current.id) || []).slice(0, REFERENCE_LIMIT);
    nextIds.forEach((nextId) => {
      if (!nodeById.has(nextId) || depthById.has(nextId)) return;
      const nextDepth = current.depth + 1;
      depthById.set(nextId, nextDepth);
      queue.push({ id: nextId, depth: nextDepth });
    });
  }

  const nodes = graphData.nodes.filter((node) => depthById.has(node.id));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const links = graphData.links.filter((link) => {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    return visibleIds.has(source) && visibleIds.has(target);
  });

  return { data: { nodes, links }, depthById };
}

export default function ResearchWebGraph({ seedPmid }: ResearchWebGraphProps) {
  const graphRef = useRef<any>(null);
  const viewportFocusTimerRef = useRef<number | null>(null);
  const focusTokenRef = useRef(0);
  const nodesRef = useRef<Map<string, PaperNode>>(new Map([[seedPmid, makeSeedNode(seedPmid)]]));
  const linksRef = useRef<Map<string, PaperLink>>(new Map());
  const expandedRef = useRef<Set<string>>(new Set());
  const loadingRef = useRef<Set<string>>(new Set());
  const depthByIdRef = useRef<Map<string, number>>(new Map([[seedPmid, 0]]));
  const focusedIdRef = useRef<string | null>(seedPmid);

  const [graphData, setGraphData] = useState<GraphData>(() => ({ nodes: [makeSeedNode(seedPmid)], links: [] }));
  const [focusedId, setFocusedId] = useState<string | null>(seedPmid);
  const [status, setStatus] = useState('Loading seed article');
  const [error, setError] = useState<string | null>(null);

  const nodeById = useMemo(() => new Map(graphData.nodes.map((node) => [node.id, node])), [graphData.nodes]);
  const focusedNode = focusedId ? nodeById.get(focusedId) || null : null;

  const selectedReferences = useMemo(() => {
    if (!focusedId) return [];
    return graphData.links
      .filter((link) => linkEndpointId(link.source) === focusedId)
      .map((link) => nodeById.get(linkEndpointId(link.target)))
      .filter((node): node is PaperNode => Boolean(node))
      .slice(0, REFERENCE_LIMIT);
  }, [focusedId, graphData.links, nodeById]);

  const visibleGraph = useMemo(() => {
    const neighborhood = buildNeighborhood(graphData, focusedId);
    depthByIdRef.current = neighborhood.depthById;
    return neighborhood.data;
  }, [focusedId, graphData]);

  const commitGraph = useCallback(() => {
    setGraphData({
      nodes: Array.from(nodesRef.current.values()),
      links: Array.from(linksRef.current.values())
    });
  }, []);

  const resetGraph = useCallback(() => {
    const seed = makeSeedNode(seedPmid);
    nodesRef.current = new Map([[seedPmid, seed]]);
    linksRef.current = new Map();
    expandedRef.current = new Set();
    loadingRef.current = new Set();
    focusTokenRef.current += 1;
    setFocusedId(seedPmid);
    focusedIdRef.current = seedPmid;
    setStatus('Loading seed article');
    setError(null);
    setGraphData({ nodes: [seed], links: [] });
  }, [seedPmid]);

  useEffect(() => {
    resetGraph();
  }, [resetGraph]);

  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  const markNodeLoading = useCallback((pmid: string, loading: boolean, failed = false) => {
    const old = nodesRef.current.get(pmid);
    if (!old) return;
    nodesRef.current.set(pmid, { ...old, loading, failed });
    commitGraph();
  }, [commitGraph]);

  const loadArticle = useCallback(async (pmid: string, depth = 0): Promise<string[]> => {
    if (expandedRef.current.has(pmid)) {
      return getOutgoingReferenceIds(linksRef.current, pmid);
    }

    if (loadingRef.current.has(pmid)) {
      return getOutgoingReferenceIds(linksRef.current, pmid);
    }

    loadingRef.current.add(pmid);
    markNodeLoading(pmid, true, false);

    try {
      const response = await fetch(`/api/pubmed/article?pmid=${pmid}&limit=${REFERENCE_LIMIT}`, { cache: 'force-cache' });
      const data = (await response.json()) as PubMedArticleResponse;

      if (!response.ok || data.error) {
        throw new Error(data.error || `Could not load PMID ${pmid}`);
      }

      const previousArticle = nodesRef.current.get(data.article.pmid);
      nodesRef.current.set(data.article.pmid, {
        ...previousArticle,
        ...data.article,
        id: data.article.pmid,
        depth: Math.min(previousArticle?.depth ?? depth, depth),
        isSeed: data.article.pmid === seedPmid,
        expanded: true,
        loading: false,
        failed: false,
        val: data.article.pmid === seedPmid ? 12 : 7
      });

      data.references.slice(0, REFERENCE_LIMIT).forEach((reference) => {
        const previous = nodesRef.current.get(reference.pmid);
        nodesRef.current.set(reference.pmid, {
          ...previous,
          ...reference,
          id: reference.pmid,
          depth: Math.min(previous?.depth ?? depth + 1, depth + 1),
          expanded: previous?.expanded || false,
          loading: previous?.loading || false,
          failed: previous?.failed || false,
          val: Math.max(previous?.val || 0, 5.6 - depth * 0.35)
        });
      });

      data.links.slice(0, REFERENCE_LIMIT).forEach((link) => {
        linksRef.current.set(`${link.source}->${link.target}`, {
          source: link.source,
          target: link.target,
          type: 'reference'
        });
      });

      expandedRef.current.add(pmid);
      commitGraph();
      return getOutgoingReferenceIds(linksRef.current, pmid);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'Unknown loading error';
      setError(message);
      markNodeLoading(pmid, false, true);
      return getOutgoingReferenceIds(linksRef.current, pmid);
    } finally {
      loadingRef.current.delete(pmid);
    }
  }, [commitGraph, markNodeLoading, seedPmid]);

  const ensureFiveDegrees = useCallback(async (centerId: string) => {
    const token = ++focusTokenRef.current;
    const visited = new Set<string>([centerId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: centerId, depth: 0 }];
    let fetches = 0;

    setError(null);
    setStatus(`Expanding 5 degrees from PMID ${centerId}`);

    while (queue.length > 0 && token === focusTokenRef.current && fetches < MAX_AUTO_FETCHES_PER_FOCUS) {
      const current = queue.shift();
      if (!current || current.depth >= RENDER_DEGREES) continue;

      const wasExpanded = expandedRef.current.has(current.id);
      const references = await loadArticle(current.id, current.depth);
      if (token !== focusTokenRef.current) return;
      if (!wasExpanded) fetches += 1;

      references.forEach((referenceId) => {
        if (visited.has(referenceId)) return;
        visited.add(referenceId);
        queue.push({ id: referenceId, depth: current.depth + 1 });
      });

      setStatus(
        `Rendering ${Math.min(RENDER_DEGREES, Math.max(1, current.depth + 1))}/5 degrees from PMID ${centerId}`
      );
    }

    if (token === focusTokenRef.current) {
      setStatus(`${visited.size} papers loaded around PMID ${centerId}`);
    }
  }, [loadArticle]);

  useEffect(() => {
    if (!focusedId) return;
    void ensureFiveDegrees(focusedId);
  }, [ensureFiveDegrees, focusedId]);

  const focusNode = useCallback((node: PaperNode, center = true) => {
    setFocusedId(node.id);
    focusedIdRef.current = node.id;

    if (center && graphRef.current && typeof node.x === 'number' && typeof node.y === 'number') {
      graphRef.current.centerAt(node.x, node.y, 650);
      const currentZoom = graphRef.current.zoom?.() || 1;
      if (currentZoom < 0.9) graphRef.current.zoom(0.95, 650);
    }
  }, []);

  const updateFocusFromViewport = useCallback(() => {
    const graph = graphRef.current;
    if (!graph?.screen2GraphCoords) return;

    const centerScreenX = window.innerWidth * 0.44;
    const centerScreenY = window.innerHeight * 0.5;
    const center = graph.screen2GraphCoords(centerScreenX, centerScreenY);

    let nearest: PaperNode | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    visibleGraph.nodes.forEach((node) => {
      if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
      const distance = Math.hypot(node.x - center.x, node.y - center.y);
      if (distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
    });

    if (nearest && nearest.id !== focusedIdRef.current) {
      setFocusedId(nearest.id);
      focusedIdRef.current = nearest.id;
    }
  }, [visibleGraph.nodes]);

  const scheduleViewportFocusUpdate = useCallback(() => {
    if (viewportFocusTimerRef.current) window.clearTimeout(viewportFocusTimerRef.current);
    viewportFocusTimerRef.current = window.setTimeout(updateFocusFromViewport, 160);
  }, [updateFocusFromViewport]);

  const drawNode = useCallback((node: PaperNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const degree = depthByIdRef.current.get(node.id) ?? RENDER_DEGREES;
    const isFocused = node.id === focusedIdRef.current;
    const opacity = isFocused ? 1 : Math.max(0.22, 0.92 - degree * 0.13);
    const radius = isFocused ? 8.4 : Math.max(3.7, 6.2 - degree * 0.35);

    ctx.save();
    ctx.globalAlpha = opacity;

    const glowRadius = radius * (isFocused ? 5.2 : 3.3);
    const glow = ctx.createRadialGradient(node.x || 0, node.y || 0, radius * 0.2, node.x || 0, node.y || 0, glowRadius);
    glow.addColorStop(0, isFocused ? 'rgba(255,255,255,0.38)' : 'rgba(200,212,255,0.24)');
    glow.addColorStop(1, 'rgba(200,212,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(node.x || 0, node.y || 0, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    const nodeGradient = ctx.createRadialGradient(
      (node.x || 0) - radius * 0.28,
      (node.y || 0) - radius * 0.32,
      radius * 0.2,
      node.x || 0,
      node.y || 0,
      radius
    );
    nodeGradient.addColorStop(0, node.failed ? '#ffd2d2' : '#ffffff');
    nodeGradient.addColorStop(0.45, node.failed ? '#ffaaaa' : '#cfd8ff');
    nodeGradient.addColorStop(1, node.failed ? '#bc6060' : '#6f83c9');

    ctx.fillStyle = nodeGradient;
    ctx.strokeStyle = isFocused ? 'rgba(255,255,255,0.86)' : 'rgba(255,255,255,0.42)';
    ctx.lineWidth = isFocused ? 1.5 / globalScale : 0.8 / globalScale;
    ctx.beginPath();
    ctx.arc(node.x || 0, node.y || 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (node.loading) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.2 / globalScale;
      ctx.beginPath();
      ctx.arc(node.x || 0, node.y || 0, radius + 3, 0, Math.PI * 1.35);
      ctx.stroke();
    }

    const shouldLabel = isFocused || degree <= 1 || globalScale > 1.25;
    if (shouldLabel) {
      const label = shortTitle(node.title, isFocused ? 70 : 42);
      const fontSize = (isFocused ? 13 : 10) / globalScale;
      ctx.font = `${fontSize}px Inter, ui-sans-serif, system-ui`;
      const textWidth = ctx.measureText(label).width;
      const x = (node.x || 0) - textWidth / 2;
      const y = (node.y || 0) + radius + 15 / globalScale;
      const padX = 7 / globalScale;
      const padY = 4 / globalScale;

      ctx.fillStyle = isFocused ? 'rgba(9,10,14,0.88)' : 'rgba(9,10,14,0.68)';
      ctx.strokeStyle = isFocused ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1 / globalScale;
      ctx.beginPath();
      ctx.roundRect(x - padX, y - fontSize - padY, textWidth + padX * 2, fontSize + padY * 2, 8 / globalScale);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isFocused ? 'rgba(247,247,242,0.96)' : 'rgba(247,247,242,0.72)';
      ctx.fillText(label, x, y - 2 / globalScale);
    }

    ctx.restore();
  }, []);

  const drawPointerArea = useCallback((node: PaperNode, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x || 0, node.y || 0, 14, 0, 2 * Math.PI, false);
    ctx.fill();
  }, []);

  return (
    <main className="research-shell">
      <div className="graph-canvas" aria-label="Research paper reference graph">
        <ForceGraph2D
          ref={graphRef}
          graphData={visibleGraph}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeVal={(node: PaperNode) => (node.id === focusedId ? 11 : Math.max(3.5, node.val || 4))}
          nodeRelSize={4}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={drawPointerArea}
          linkColor={(link: PaperLink) => {
            const source = linkEndpointId(link.source);
            const sourceDegree = depthByIdRef.current.get(source) ?? RENDER_DEGREES;
            const alpha = Math.max(0.08, 0.58 - sourceDegree * 0.09);
            return `rgba(202,213,255,${alpha})`;
          }}
          linkWidth={(link: PaperLink) => {
            const source = linkEndpointId(link.source);
            const target = linkEndpointId(link.target);
            return source === focusedId || target === focusedId ? 1.25 : 0.45;
          }}
          linkDirectionalParticles={(link: PaperLink) => (linkEndpointId(link.source) === focusedId ? 2 : 0)}
          linkDirectionalParticleWidth={1.7}
          linkDirectionalParticleSpeed={0.005}
          d3AlphaDecay={0.025}
          d3VelocityDecay={0.28}
          cooldownTicks={160}
          enableNodeDrag
          enablePanInteraction
          enableZoomInteraction
          onNodeClick={(node: PaperNode) => focusNode(node, true)}
          onNodeDragEnd={(node: PaperNode) => focusNode(node, false)}
          onZoomEnd={scheduleViewportFocusUpdate}
          onEngineStop={scheduleViewportFocusUpdate}
        />
      </div>

      <div className={`focus-blur${focusedId ? ' active' : ''}`} />
      <div className="vignette" />

      <div className="topbar">
        <section className="brand-card">
          <h1 className="brand-title">ResearchWeb</h1>
          <p className="brand-subtitle">
            Obsidian-style PubMed graph. The paper closest to the viewport center becomes active and auto-loads five outward levels.
          </p>
        </section>

        <section className="status-card">
          <strong>{visibleGraph.nodes.length}</strong>
          visible · {graphData.nodes.length} loaded
          <br />
          {error ? <span className="error-text">{error}</span> : status}
        </section>
      </div>

      <aside className="side-wrap">
        {focusedNode ? (
          <section className="paper-panel">
            <header>
              <p className="kicker">PMID {focusedNode.pmid}</p>
              <h2 className="paper-title">{focusedNode.title}</h2>
              <div className="meta-row">
                {focusedNode.year ? <span className="pill">{focusedNode.year}</span> : null}
                <span className="pill">{focusedNode.source}</span>
                {focusedNode.loading ? (
                  <span className="pill loading-chip"><span className="loading-dot" /> loading</span>
                ) : null}
                {focusedNode.expanded ? <span className="pill">expanded</span> : null}
                <span className="pill">5-degree view</span>
              </div>
              <div className="panel-actions">
                <button className="ghost-button" onClick={() => void ensureFiveDegrees(focusedNode.id)}>
                  Refresh neighborhood
                </button>
                <button className="ghost-button" onClick={() => window.open(`https://pubmed.ncbi.nlm.nih.gov/${focusedNode.pmid}/`, '_blank')}>
                  Open PubMed
                </button>
              </div>
            </header>

            <ul className="reference-list" aria-label="References">
              {focusedNode.loading ? (
                <li className="reference-meta">Loading references from PubMed.</li>
              ) : selectedReferences.length > 0 ? (
                selectedReferences.map((reference) => (
                  <li key={reference.id}>
                    <button className="reference-button" onClick={() => focusNode(reference, true)}>
                      <span className="reference-title">{reference.title}</span>
                      <span className="reference-meta">
                        PMID {reference.pmid}{reference.year ? ` · ${reference.year}` : ''}
                      </span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="reference-meta">
                  References are loading automatically for the centered paper.
                </li>
              )}
            </ul>
          </section>
        ) : (
          <section className="empty-panel">
            <p>Pan the graph or click a node. The node closest to the viewport center becomes active.</p>
            <button className="ghost-button" onClick={() => setFocusedId(seedPmid)}>Return to seed</button>
          </section>
        )}
      </aside>

      <section className="hint-card">
        Drag nodes, pan, and zoom like an Obsidian graph. The viewport-center paper is the active node and loads its next five levels automatically.
      </section>
    </main>
  );
}
