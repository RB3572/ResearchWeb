'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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

type PositionedNode = PaperNode & {
  px: number;
  py: number;
  scale: number;
  blur: number;
  focused: boolean;
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

function shortTitle(title: string, max = 44) {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1).trim()}…`;
}

export default function ResearchWebGraph({ seedPmid }: ResearchWebGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>(() => ({ nodes: [makeSeedNode(seedPmid)], links: [] }));
  const [selectedId, setSelectedId] = useState<string | null>(seedPmid);
  const [status, setStatus] = useState('Loading seed article');
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());

  const nodeById = useMemo(() => {
    return new Map(graphData.nodes.map((node) => [node.id, node]));
  }, [graphData.nodes]);

  const selectedNode = selectedId ? nodeById.get(selectedId) || null : null;

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

  const selectedReferences = useMemo(() => {
    if (!selectedId) return [];
    return graphData.links
      .filter((link) => linkEndpointId(link.source) === selectedId)
      .map((link) => nodeById.get(linkEndpointId(link.target)))
      .filter((node): node is PaperNode => Boolean(node));
  }, [graphData.links, nodeById, selectedId]);

  const positionedNodes = useMemo(() => {
    const width = 100;
    const height = 100;
    const centerX = 44;
    const centerY = 50;
    const selected = selectedId ? nodeById.get(selectedId) : null;
    const connectedIds = selectedId ? Array.from(focusIds).filter((id) => id !== selectedId) : [];
    const nonFocus = graphData.nodes.filter((node) => selectedId && !focusIds.has(node.id));
    const nodeMap = new Map<string, PositionedNode>();

    if (selected) {
      nodeMap.set(selected.id, {
        ...selected,
        px: centerX,
        py: centerY,
        scale: selected.isSeed ? 1.38 : 1.24,
        blur: 0,
        focused: true
      });
    }

    connectedIds.forEach((id, index) => {
      const node = nodeById.get(id);
      if (!node) return;
      const total = Math.max(connectedIds.length, 1);
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
      const radiusX = total <= 6 ? 24 : 30;
      const radiusY = total <= 6 ? 25 : 31;
      nodeMap.set(node.id, {
        ...node,
        px: centerX + Math.cos(angle) * radiusX,
        py: centerY + Math.sin(angle) * radiusY,
        scale: 0.92,
        blur: 0,
        focused: true
      });
    });

    if (!selected && graphData.nodes.length > 0) {
      graphData.nodes.forEach((node, index) => {
        const total = Math.max(graphData.nodes.length, 1);
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
        const radius = node.isSeed ? 0 : 30;
        nodeMap.set(node.id, {
          ...node,
          px: centerX + Math.cos(angle) * radius,
          py: centerY + Math.sin(angle) * radius,
          scale: node.isSeed ? 1.25 : 0.9,
          blur: 0,
          focused: true
        });
      });
    }

    nonFocus.forEach((node, index) => {
      if (nodeMap.has(node.id)) return;
      const total = Math.max(nonFocus.length, 1);
      const angle = Math.PI / 4 + (Math.PI * 2 * index) / total;
      const radiusX = 38;
      const radiusY = 39;
      nodeMap.set(node.id, {
        ...node,
        px: centerX + Math.cos(angle) * radiusX,
        py: centerY + Math.sin(angle) * radiusY,
        scale: 0.62,
        blur: 3.2,
        focused: false
      });
    });

    return Array.from(nodeMap.values()).map((node) => ({
      ...node,
      px: Math.max(9, Math.min(width - 9, node.px)),
      py: Math.max(10, Math.min(height - 10, node.py))
    }));
  }, [focusIds, graphData.nodes, nodeById, selectedId]);

  const positionedNodeById = useMemo(() => {
    return new Map(positionedNodes.map((node) => [node.id, node]));
  }, [positionedNodes]);

  const visibleLinks = useMemo(() => {
    return graphData.links
      .map((link) => {
        const sourceId = linkEndpointId(link.source);
        const targetId = linkEndpointId(link.target);
        const source = positionedNodeById.get(sourceId);
        const target = positionedNodeById.get(targetId);
        if (!source || !target) return null;
        const focused = !selectedId || sourceId === selectedId || targetId === selectedId;
        return { source, target, focused };
      })
      .filter((link): link is { source: PositionedNode; target: PositionedNode; focused: boolean } => Boolean(link));
  }, [graphData.links, positionedNodeById, selectedId]);

  const expandArticle = useCallback(async (pmid: string, depth = 0) => {
    if (expandedIds.has(pmid) || loadingIds.has(pmid)) return;

    setLoadingIds((current) => new Set(current).add(pmid));
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

      setExpandedIds((current) => new Set(current).add(pmid));
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
      setLoadingIds((current) => {
        const next = new Set(current);
        next.delete(pmid);
        return next;
      });
    }
  }, [expandedIds, loadingIds, seedPmid]);

  useEffect(() => {
    setGraphData({ nodes: [makeSeedNode(seedPmid)], links: [] });
    setSelectedId(seedPmid);
    setStatus('Loading seed article');
    setError(null);
    setExpandedIds(new Set());
    setLoadingIds(new Set());
  }, [seedPmid]);

  useEffect(() => {
    void expandArticle(seedPmid, 0);
  }, [expandArticle, seedPmid]);

  const selectNode = useCallback((node: PaperNode) => {
    setSelectedId(node.id);
    void expandArticle(node.id, node.depth);
  }, [expandArticle]);

  return (
    <main className="research-shell">
      <div className="graph-plane" aria-label="Research paper reference graph">
        <svg className="graph-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="0.9" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {visibleLinks.map((link) => (
            <line
              key={`${link.source.id}-${link.target.id}`}
              x1={link.source.px}
              y1={link.source.py}
              x2={link.target.px}
              y2={link.target.py}
              className={link.focused ? 'graph-link focused' : 'graph-link dimmed'}
            />
          ))}
        </svg>

        <div className="graph-depth-field" />

        {positionedNodes.map((node) => {
          const isSelected = node.id === selectedId;
          const size = node.isSeed ? 22 : 16;
          return (
            <button
              key={node.id}
              className={`graph-node${isSelected ? ' selected' : ''}${node.focused ? ' focused' : ' dimmed'}${node.loading ? ' loading' : ''}`}
              style={{
                left: `${node.px}%`,
                top: `${node.py}%`,
                width: `${size}px`,
                height: `${size}px`,
                transform: `translate(-50%, -50%) scale(${node.scale})`,
                filter: node.blur ? `blur(${node.blur}px)` : undefined
              }}
              title={node.title}
              onClick={() => selectNode(node)}
              aria-label={node.title}
            >
              <span className="node-core" />
              <span className="node-halo" />
              {(isSelected || node.isSeed || node.focused) && (
                <span className="node-label">{shortTitle(node.title, isSelected ? 58 : 34)}</span>
              )}
            </button>
          );
        })}
      </div>

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
        Click any paper node to focus and load its references. Background click clears the focus blur.
      </section>
    </main>
  );
}
