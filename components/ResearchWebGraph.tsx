'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import SpriteText from 'three-spritetext';

const ForceGraph3D = dynamic(() => import('react-force-graph-3d'), { ssr: false }) as any;

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

type PubMedArticleResponse = {
  article: PubMedArticle;
  references: PubMedArticle[];
  links: Array<{ source: string; target: string; type: 'reference' }>;
  error?: string;
};

type ResearchWebGraphProps = {
  seedPmid: string;
};

function compactTitle(title: string, maxLength = 68) {
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1).trim()}…`;
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
  const graphRef = useRef<any>(null);
  const expandedRef = useRef(new Set<string>());
  const loadingRef = useRef(new Set<string>());

  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
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
      const response = await fetch(`/api/pubmed/article?pmid=${pmid}&limit=28`);
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
        val: data.article.pmid === seedPmid ? 9 : 5
      };

      const referenceNodes: PaperNode[] = data.references.map((reference) => ({
        ...reference,
        id: reference.pmid,
        depth: depth + 1,
        expanded: false,
        loading: false,
        failed: false,
        val: Math.max(2.5, 4.6 - depth * 0.45)
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
    setGraphData({
      nodes: [
        {
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
          val: 9
        }
      ],
      links: []
    });
    setSelectedId(seedPmid);
    expandedRef.current.clear();
    loadingRef.current.clear();
    void expandArticle(seedPmid, 0);
  }, [expandArticle, seedPmid]);

  useEffect(() => {
    if (!graphRef.current) return;

    graphRef.current.d3Force('charge')?.strength(-110);
    graphRef.current.d3Force('link')?.distance(78);
    graphRef.current.d3Force('center')?.strength?.(0.08);
  }, [graphData.nodes.length]);

  useEffect(() => {
    if (!graphRef.current) return;
    const scene = graphRef.current.scene();
    scene.fog = new THREE.FogExp2(0x050507, selectedId ? 0.004 : 0.0021);
  }, [selectedId]);

  const focusCameraOnNode = useCallback((node: PaperNode) => {
    if (!graphRef.current || typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') {
      return;
    }

    const distance = 120;
    const length = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + distance / length;

    graphRef.current.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      { x: node.x, y: node.y, z: node.z },
      900
    );
  }, []);

  const selectNode = useCallback((node: PaperNode) => {
    setSelectedId(node.id);
    focusCameraOnNode(node);
    void expandArticle(node.id, node.depth);
  }, [expandArticle, focusCameraOnNode]);

  const isLinkFocused = useCallback((link: PaperLink) => {
    if (!selectedId) return true;
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    return source === selectedId || target === selectedId;
  }, [selectedId]);

  const nodeObject = useCallback((node: PaperNode) => {
    const group = new THREE.Group();
    const isSelected = node.id === selectedId;
    const isContext = !selectedId || focusIds.has(node.id);
    const isSeed = node.isSeed;
    const radius = isSelected ? 5.4 : isSeed ? 4.6 : 3.1;
    const color = node.failed ? '#ff9999' : isSelected ? '#ffffff' : isSeed ? '#c8d4ff' : '#9eb6d8';
    const opacity = isContext ? (isSelected ? 1 : 0.76) : 0.1;

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 28, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false
      })
    );

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 2.45, 28, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: isSelected ? 0.09 : isContext ? 0.035 : 0.006,
        depthWrite: false
      })
    );

    group.add(glow);
    group.add(sphere);

    if (isSelected || isSeed || node.depth < 2) {
      const label = new SpriteText(compactTitle(node.title, isSelected ? 76 : 42));
      label.color = isContext ? 'rgba(247, 247, 242, 0.88)' : 'rgba(247, 247, 242, 0.16)';
      label.textHeight = isSelected ? 4.1 : 2.35;
      label.position.y = radius + 4.2;
      label.material.depthWrite = false;
      label.material.transparent = true;
      label.material.opacity = isContext ? (isSelected ? 0.95 : 0.62) : 0.14;
      group.add(label);
    }

    return group;
  }, [focusIds, selectedId]);

  const nodeLabel = useCallback((node: PaperNode) => {
    const authors = node.authors.length ? node.authors.slice(0, 3).join(', ') : 'Unknown authors';
    const date = node.year ? ` (${node.year})` : '';
    return `${node.title}${date}<br/><span style="opacity:.65">${authors}</span>`;
  }, []);

  return (
    <main className="research-shell">
      <div className="graph-canvas">
        <ForceGraph3D
          ref={graphRef}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeId="id"
          nodeVal="val"
          nodeLabel={nodeLabel}
          nodeThreeObject={nodeObject}
          nodeThreeObjectExtend={false}
          linkLabel={() => 'references'}
          linkColor={(link: PaperLink) => (isLinkFocused(link) ? 'rgba(226, 232, 255, 0.5)' : 'rgba(255, 255, 255, 0.045)')}
          linkWidth={(link: PaperLink) => (isLinkFocused(link) ? 0.72 : 0.16)}
          linkDirectionalParticles={(link: PaperLink) => (isLinkFocused(link) ? 1 : 0)}
          linkDirectionalParticleWidth={1.3}
          linkDirectionalParticleSpeed={0.0035}
          cooldownTicks={90}
          enableNodeDrag
          onNodeClick={selectNode}
          onBackgroundClick={() => setSelectedId(null)}
        />
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
        Click any paper node to focus and load its references. Drag to rotate. Scroll to zoom. Background click clears the focus blur.
      </section>
    </main>
  );
}
