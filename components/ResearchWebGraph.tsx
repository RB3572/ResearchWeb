'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  z?: number;
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
    val: 10
  };
}

function linkEndpointId(endpoint: string | PaperNode) {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

function mergeGraph(existing: GraphData, incomingNodes: PaperNode[], incomingLinks: PaperLink[]): GraphData {
  const nodeMap = new Map(existing.nodes.map((node) => [node.id, node]));

  incomingNodes.forEach((node) => {
    const previous = nodeMap.get(node.id);
    nodeMap.set(node.id, {
      ...previous,
      ...node,
      depth: Math.min(previous?.depth ?? node.depth, node.depth),
      val: previous?.val && previous.val > node.val ? previous.val : node.val
    });
  });

  const linkMap = new Map(
    existing.links.map((link) => [`${linkEndpointId(link.source)}->${linkEndpointId(link.target)}`, link])
  );

  incomingLinks.forEach((link) => {
    linkMap.set(`${linkEndpointId(link.source)}->${linkEndpointId(link.target)}`, link);
  });

  return {
    nodes: Array.from(nodeMap.values()),
    links: Array.from(linkMap.values())
  };
}

export default function ResearchWebGraph({ seedPmid }: ResearchWebGraphProps) {
  const graphElRef = useRef<HTMLDivElement | null>(null);
  const graphInstanceRef = useRef<any>(null);
  const selectedIdRef = useRef<string | null>(seedPmid);
  const focusIdsRef = useRef<Set<string>>(new Set([seedPmid]));
  const selectNodeRef = useRef<(node: PaperNode) => void>(() => {});
  const expandedRef = useRef(new Set<string>());
  const loadingRef = useRef(new Set<string>());
  const hasFitGraphRef = useRef(false);

  const [graphData, setGraphData] = useState<GraphData>(() => ({ nodes: [makeSeedNode(seedPmid)], links: [] }));
  const [selectedId, setSelectedId] = useState<string | null>(seedPmid);
  const [status, setStatus] = useState('Loading seed article');
  const [error, setError] = useState<string | null>(null);

  const nodeById = useMemo(() => {
    return new Map(graphData.nodes.map((node) => [node.id, node]));
  }, [graphData.nodes]);

  const selectedNode = selectedId ? nodeById.get(selectedId) || null : null;

  const selectedReferenceIds = useMemo(() => {
    if (!selectedId) return [];
    return graphData.links
      .filter((link) => linkEndpointId(link.source) === selectedId)
      .map((link) => linkEndpointId(link.target));
  }, [graphData.links, selectedId]);

  const selectedReferences = useMemo(() => {
    return selectedReferenceIds
      .map((id) => nodeById.get(id))
      .filter((node): node is PaperNode => Boolean(node));
  }, [nodeById, selectedReferenceIds]);

  const focusIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;

    ids.add(selectedId);
    graphData.links.forEach((link) => {
      const source = linkEndpointId(link.source);
      const target = linkEndpointId(link.target);

      if (source === selectedId) ids.add(target);
      if (target === selectedId) ids.add(source);
    });

    return ids;
  }, [graphData.links, selectedId]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    focusIdsRef.current = focusIds;

    const graph = graphInstanceRef.current;
    if (graph) {
      graph.graphData(graphData);
    }
  }, [focusIds, graphData, selectedId]);

  const expandArticle = useCallback(async (pmid: string, depth = 0) => {
    if (expandedRef.current.has(pmid) || loadingRef.current.has(pmid)) return;

    loadingRef.current.add(pmid);
    setStatus(`Loading PMID ${pmid}`);
    setError(null);
    setGraphData((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === pmid ? { ...node, loading: true, failed: false } : node))
    }));

    try {
      const response = await fetch(`/api/pubmed/article?pmid=${pmid}&limit=34`, { cache: 'force-cache' });
      const data = (await response.json()) as PubMedArticleResponse;

      if (!response.ok || data.error) {
        throw new Error(data.error || `Could not load PMID ${pmid}`);
      }

      const articleNode: PaperNode = {
        ...data.article,
        id: data.article.pmid,
        depth,
        isSeed: data.article.pmid === seedPmid,
        expanded: true,
        loading: false,
        failed: false,
        val: data.article.pmid === seedPmid ? 12 : 7
      };

      const referenceNodes: PaperNode[] = data.references.map((reference) => ({
        ...reference,
        id: reference.pmid,
        depth: depth + 1,
        expanded: false,
        loading: false,
        failed: false,
        val: Math.max(3.4, 6 - depth * 0.5)
      }));

      const links: PaperLink[] = data.links.map((link) => ({
        source: link.source,
        target: link.target,
        type: 'reference'
      }));

      expandedRef.current.add(pmid);
      setGraphData((current) => mergeGraph(current, [articleNode, ...referenceNodes], links));
      setStatus(`${data.references.length} references loaded for PMID ${pmid}`);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'Unknown loading error';
      setError(message);
      setStatus('PubMed request failed');
      setGraphData((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === pmid ? { ...node, loading: false, failed: true, expanded: false } : node
        )
      }));
    } finally {
      loadingRef.current.delete(pmid);
    }
  }, [seedPmid]);

  useEffect(() => {
    setGraphData({ nodes: [makeSeedNode(seedPmid)], links: [] });
    setSelectedId(seedPmid);
    setStatus('Loading seed article');
    setError(null);
    hasFitGraphRef.current = false;
    expandedRef.current.clear();
    loadingRef.current.clear();
    void expandArticle(seedPmid, 0);
  }, [expandArticle, seedPmid]);

  const focusCameraOnNode = useCallback((node: PaperNode) => {
    const graph = graphInstanceRef.current;
    if (!graph || typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') {
      return;
    }

    const distance = 150;
    const length = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + distance / length;

    graph.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      { x: node.x, y: node.y, z: node.z },
      850
    );
  }, []);

  const selectNode = useCallback((node: PaperNode) => {
    setSelectedId(node.id);
    focusCameraOnNode(node);
    void expandArticle(node.id, node.depth);
  }, [expandArticle, focusCameraOnNode]);

  useEffect(() => {
    selectNodeRef.current = selectNode;
  }, [selectNode]);

  useEffect(() => {
    let destroyed = false;
    let graph: any;

    async function initializeGraph() {
      if (!graphElRef.current || graphInstanceRef.current) return;

      const module = await import('3d-force-graph');
      if (destroyed || !graphElRef.current) return;

      const ForceGraph3D = module.default || module;
      graph = ForceGraph3D()(graphElRef.current);
      graphInstanceRef.current = graph;

      const isNodeFocused = (node: PaperNode) => {
        const selected = selectedIdRef.current;
        return !selected || focusIdsRef.current.has(node.id);
      };

      const isLinkFocused = (link: PaperLink) => {
        const selected = selectedIdRef.current;
        if (!selected) return true;
        const source = linkEndpointId(link.source);
        const target = linkEndpointId(link.target);
        return source === selected || target === selected;
      };

      graph
        .backgroundColor('rgba(0,0,0,0)')
        .showNavInfo(false)
        .nodeId('id')
        .nodeVal((node: PaperNode) => {
          if (node.id === selectedIdRef.current) return 18;
          if (node.isSeed) return 13;
          return node.val;
        })
        .nodeResolution(24)
        .nodeColor((node: PaperNode) => {
          if (node.failed) return '#ffb4b4';
          if (node.id === selectedIdRef.current) return '#ffffff';
          if (node.isSeed) return '#d6ddff';
          return isNodeFocused(node) ? '#aebee8' : '#293041';
        })
        .nodeOpacity((node: PaperNode) => (isNodeFocused(node) ? 0.96 : 0.14))
        .nodeLabel((node: PaperNode) => {
          const authors = node.authors.length ? node.authors.slice(0, 3).join(', ') : 'Unknown authors';
          const date = node.year ? ` (${node.year})` : '';
          return `${node.title}${date}<br/><span style="opacity:.65">${authors}</span>`;
        })
        .linkColor((link: PaperLink) => (isLinkFocused(link) ? '#c7d1ff' : '#1a1d29'))
        .linkOpacity((link: PaperLink) => (isLinkFocused(link) ? 0.52 : 0.055))
        .linkWidth((link: PaperLink) => (isLinkFocused(link) ? 0.9 : 0.18))
        .linkDirectionalParticles((link: PaperLink) => (isLinkFocused(link) ? 1 : 0))
        .linkDirectionalParticleWidth(1.4)
        .linkDirectionalParticleSpeed(0.0032)
        .enableNodeDrag(true)
        .onNodeClick((node: PaperNode) => selectNodeRef.current(node))
        .onBackgroundClick(() => setSelectedId(null))
        .graphData(graphData);

      graph.d3Force('charge')?.strength(-135);
      graph.d3Force('link')?.distance(92);
      graph.d3Force('center')?.strength?.(0.08);

      const scene = graph.scene?.();
      if (scene && module) {
        const three = await import('three');
        scene.fog = new three.FogExp2(0x050507, 0.0028);
      }

      const resize = () => {
        if (!graphElRef.current || !graphInstanceRef.current) return;
        graphInstanceRef.current.width(graphElRef.current.clientWidth).height(graphElRef.current.clientHeight);
      };

      resize();
      window.addEventListener('resize', resize);

      return () => window.removeEventListener('resize', resize);
    }

    const cleanupPromise = initializeGraph();

    return () => {
      destroyed = true;
      cleanupPromise.then((cleanup) => cleanup?.()).catch(() => undefined);
      if (graphInstanceRef.current?._destructor) {
        graphInstanceRef.current._destructor();
      }
      graphInstanceRef.current = null;
    };
  }, [graphData]);

  useEffect(() => {
    const graph = graphInstanceRef.current;
    if (!graph) return;

    graph.graphData(graphData);
    graph.refresh?.();

    if (graphData.nodes.length > 1 && !hasFitGraphRef.current) {
      hasFitGraphRef.current = true;
      window.setTimeout(() => graph.zoomToFit?.(650, 90), 300);
    }
  }, [graphData, selectedId, focusIds]);

  return (
    <main className="research-shell">
      <div className="graph-canvas" ref={graphElRef} aria-label="Research paper reference graph" />

      <div className={`focus-blur${selectedId ? ' active' : ''}`} />
      <div className="vignette" />

      <div className="topbar">
        <section className="brand-card">
          <h1 className="brand-title">ResearchWeb</h1>
          <p className="brand-subtitle">
            A minimal PubMed reference graph. Start from one paper, click outward, and let each reference become a node.
          </p>
        </section>

        <section className="status-card">
          <strong>{graphData.nodes.length}</strong>
          nodes · {graphData.links.length} links
          <br />
          {error ? <span className="error-text">{error}</span> : status}
        </section>
      </div>

      <aside className="side-wrap">
        {selectedNode ? (
          <section className="paper-panel">
            <header>
              <p className="kicker">PMID {selectedNode.pmid}</p>
              <h2 className="paper-title">{selectedNode.title}</h2>
              <div className="meta-row">
                {selectedNode.year ? <span className="pill">{selectedNode.year}</span> : null}
                <span className="pill">{selectedNode.source}</span>
                {selectedNode.loading ? (
                  <span className="pill loading-chip"><span className="loading-dot" /> loading</span>
                ) : null}
                {selectedNode.expanded ? <span className="pill">expanded</span> : null}
              </div>
              <div className="panel-actions">
                <button className="ghost-button" onClick={() => void expandArticle(selectedNode.id, selectedNode.depth)}>
                  Expand references
                </button>
                <button className="ghost-button" onClick={() => window.open(`https://pubmed.ncbi.nlm.nih.gov/${selectedNode.pmid}/`, '_blank')}>
                  Open PubMed
                </button>
              </div>
            </header>

            <ul className="reference-list" aria-label="References">
              {selectedNode.loading ? (
                <li className="reference-meta">Loading references from PubMed.</li>
              ) : selectedReferences.length > 0 ? (
                selectedReferences.map((reference) => (
                  <li key={reference.id}>
                    <button className="reference-button" onClick={() => selectNode(reference)}>
                      <span className="reference-title">{reference.title}</span>
                      <span className="reference-meta">
                        PMID {reference.pmid}{reference.year ? ` · ${reference.year}` : ''}
                      </span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="reference-meta">
                  No references are loaded for this node yet. Use Expand references or choose another connected paper.
                </li>
              )}
            </ul>
          </section>
        ) : (
          <section className="empty-panel">
            <p>Click a node to focus it and open its reference list.</p>
            <button className="ghost-button" onClick={() => setSelectedId(seedPmid)}>Return to seed</button>
          </section>
        )}
      </aside>

      <section className="hint-card">
        Click any paper node to focus and load its references. Drag to rotate. Scroll to zoom. Background click clears the focus blur.
      </section>
    </main>
  );
}
