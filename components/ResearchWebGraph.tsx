'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import DotField from './DotField';
import GraphLoader from './GraphLoader';

// next/dynamic doesn't forward refs — wrap the import so the graph handle
// (zoomToFit, centerAt, d3Force) actually reaches us via the `fgRef` prop.
const ForceGraph2D = dynamic(
  () =>
    import('react-force-graph-2d').then((mod) => {
      const ForceGraph = mod.default as any;
      function ForceGraphWithRef({ fgRef, ...props }: any) {
        return <ForceGraph ref={fgRef} {...props} />;
      }
      return ForceGraphWithRef;
    }),
  { ssr: false }
) as any;

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

type GraphNodeData = PaperSummary & { depth: number; expanded?: boolean };

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

// Eased per-node / per-link visual state (lerped every frame — no hard jumps).
type NodeVisual = { a: number; s: number; hl: number; dim: number; la: number; sel: number };
type LinkVisual = { a: number; w: number; h: number };

const AUTO_EXPAND_MAX = 16;
const EASE = 0.09;

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

const CREAM: [number, number, number] = [255, 243, 216];

type Theme = 'dark' | 'light';

// Node fills stay Monet in both themes; only the neutral chrome (links, labels,
// selection ring) flips so it stays legible on a black-or-white backdrop.
const THEME_PALETTE: Record<
  Theme,
  { link: [number, number, number]; linkHot: [number, number, number]; label: string }
> = {
  dark: {
    link: [198, 198, 202],
    linkHot: [240, 238, 230],
    label: '243, 240, 236'
  },
  light: {
    link: [90, 90, 96],
    linkHot: [40, 40, 46],
    label: '26, 26, 30'
  }
};

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped)
  ];
}

function rampColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (MONET_RAMP.length - 1);
  const index = Math.floor(scaled);
  return mix(MONET_RAMP[index], MONET_RAMP[Math.min(index + 1, MONET_RAMP.length - 1)], scaled - index);
}

function rgba([r, g, b]: [number, number, number], alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lerp(from: number, to: number, k: number): number {
  return from + (to - from) * k;
}

function endpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

export default function ResearchWebGraph({ seedPmid }: ResearchWebGraphProps) {
  const graphRef = useRef<any>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());
  const linksRef = useRef<Map<string, GraphLink>>(new Map());
  const degreeRef = useRef<Map<string, number>>(new Map());
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map());
  const detailsRef = useRef<Map<string, ArticleResponse>>(new Map());
  const pendingDetailRef = useRef<Map<string, Promise<ArticleResponse | null>>>(new Map());
  const expandedDepthRef = useRef<Map<string, number>>(new Map());
  const nodeVisualsRef = useRef<Map<string, NodeVisual>>(new Map());
  const linkVisualsRef = useRef<Map<string, LinkVisual>>(new Map());
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const centerRef = useRef<{ x: number; y: number; maxR: number }>({ x: 0, y: 0, maxR: 1 });
  const autoQueueRef = useRef<string[]>([]);
  const autoCountRef = useRef(0);
  const autoTimerRef = useRef<number | null>(null);
  const userInteractedRef = useRef(false);
  const framedRef = useRef(false);
  // Pinning must wait until the initial layout has spread out, or auto-expand
  // would freeze the whole web while it's still collapsed near the origin.
  const seedSettledRef = useRef(false);
  const seedTokenRef = useRef(0);
  const cardDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const draggingNodeRef = useRef<GraphNode | null>(null);

  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ArticleResponse | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doiValue, setDoiValue] = useState('');
  const [doiBusy, setDoiBusy] = useState(false);
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  // Size the canvas explicitly — react-force-graph's auto-sizing occasionally
  // measures the parent as 0 (e.g. after a viewport change), leaving it blank.
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [theme, setTheme] = useState<Theme>('dark');
  const themeRef = useRef<Theme>('dark');

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

  // Fit the whole web, then push in so it spills past the viewport edges —
  // dense enough that nodes reach every corner.
  const frameGraph = useCallback((zoomIn: boolean) => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.zoomToFit(650, 40);
    if (!zoomIn) return;
    window.setTimeout(() => {
      if (userInteractedRef.current) return;
      // Portrait screens leave big top/bottom gaps after a width-limited fit;
      // push in harder there so the web fills the height (spilling off the sides).
      const portrait = window.innerHeight > window.innerWidth * 1.15;
      const current = graph.zoom?.() || 1;
      graph.zoom(current * (portrait ? 2.6 : 1.9), 520);
    }, 680);
  }, []);

  // Pin every node at its current position (dead‑calm at rest).
  const freezeAll = useCallback(() => {
    nodesRef.current.forEach((node) => {
      if (typeof node.x === 'number' && typeof node.y === 'number') {
        node.fx = node.x;
        node.fy = node.y;
      }
    });
  }, []);

  // During a drag, only the dragged node's DIRECT neighbours are free to follow
  // it — the rest of the (dense) web stays pinned so it can't shimmer. This keeps
  // the drag feeling connected without the whole simulation vibrating.
  const freezeExceptNeighbors = useCallback((node: GraphNode) => {
    const neighbours = neighborsRef.current.get(node.id);
    nodesRef.current.forEach((other) => {
      if (other === node) return;
      if (neighbours && neighbours.has(other.id)) {
        other.fx = undefined;
        other.fy = undefined;
      } else if (typeof other.x === 'number' && typeof other.y === 'number') {
        other.fx = other.x;
        other.fy = other.y;
      }
    });
  }, []);

  const mergeGraph = useCallback(
    (data: GraphResponse, origin?: GraphNode, stabilize = false) => {
      // Adding nodes reheats d3's simulation to full alpha, which otherwise
      // yanks the whole layout around. Pin the existing nodes at their current
      // positions so only the newcomers move — the web *grows* instead of
      // reshuffling. Pins are released a couple seconds after growth stops.
      // Skip while a drag is active, or before the seed layout has spread —
      // pinning too early would lock the web into its collapsed initial state.
      const shouldPin = stabilize && !draggingNodeRef.current && seedSettledRef.current;
      if (shouldPin) {
        nodesRef.current.forEach((node) => {
          if (typeof node.x === 'number' && typeof node.y === 'number') {
            node.fx = node.x;
            node.fy = node.y;
          }
        });
      }

      // With a parent, newcomers emerge right beside it and ease out along
      // their links. For a bulk/seed load (no parent) pre-spread them across a
      // wide disk so the layout starts open instead of exploding from a point.
      const bulkRadius = origin ? 0 : Math.max(180, Math.sqrt(data.nodes.length) * 12);

      data.nodes.forEach((incoming) => {
        const existing = nodesRef.current.get(incoming.pmid);
        if (existing) {
          existing.title = incoming.title || existing.title;
          existing.year = incoming.year || existing.year;
          existing.source = incoming.source || existing.source;
          existing.depth = Math.min(existing.depth, incoming.depth);
          existing.expanded = existing.expanded || incoming.expanded;
        } else {
          const angle = Math.random() * Math.PI * 2;
          const distance = origin ? 10 + Math.random() * 22 : Math.sqrt(Math.random()) * bulkRadius;
          nodesRef.current.set(incoming.pmid, {
            ...incoming,
            id: incoming.pmid,
            x: (origin?.x ?? 0) + Math.cos(angle) * distance,
            y: (origin?.y ?? 0) + Math.sin(angle) * distance,
            vx: 0,
            vy: 0
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
      // Pins persist so additions never disturb the existing layout — the web
      // only ever grows. A drag releases them for physics (see onNodeDrag).
    },
    [commitGraph]
  );

  const fetchGraph = useCallback(async (pmid: string, depth: number, cap = 64): Promise<GraphResponse> => {
    const response = await fetch(`/api/pubmed/graph?pmid=${pmid}&depth=${depth}&cap=${cap}`);
    const data = (await response.json()) as GraphResponse;
    if (!response.ok || data.error) throw new Error(data.error || 'Could not build the graph.');
    return data;
  }, []);

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

  // Returns true only if it actually pulled in a deeper neighbourhood than
  // whatever depth this node was already expanded to.
  const expandGraphFrom = useCallback(
    async (pmid: string, depth = 2, cap = 24): Promise<boolean> => {
      const done = expandedDepthRef.current.get(pmid) ?? 0;
      if (done >= depth) return false;
      expandedDepthRef.current.set(pmid, depth);
      try {
        const data = await fetchGraph(pmid, depth, cap);
        mergeGraph(data, nodesRef.current.get(pmid), true);
        const node = nodesRef.current.get(pmid);
        if (node) node.expanded = true;
        return true;
      } catch {
        expandedDepthRef.current.set(pmid, done);
        return false;
      }
    },
    [fetchGraph, mergeGraph]
  );

  // ---- Background auto-expansion: quietly deepen the web (and the shared DB)
  // one stub at a time so exploration never hits a wall.
  const pumpAutoExpand = useCallback(() => {
    if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current);
    const token = seedTokenRef.current;

    const step = async () => {
      if (token !== seedTokenRef.current) return;
      if (autoCountRef.current >= AUTO_EXPAND_MAX) return;
      if (document.hidden) {
        autoTimerRef.current = window.setTimeout(step, 4000);
        return;
      }
      const next = autoQueueRef.current.shift();
      if (!next) return;
      const grew = await expandGraphFrom(next, 1, 8);
      if (grew) {
        autoCountRef.current += 1;
        // Keep it centered while filling; don't re-zoom once framed.
        if (token === seedTokenRef.current && !userInteractedRef.current && !framedRef.current) {
          graphRef.current?.zoomToFit(700, 40);
        }
      }
      // Hurry while the web is still sparse; relax once it fills out.
      const delay = nodesRef.current.size < 80 ? 500 : 1400;
      autoTimerRef.current = window.setTimeout(step, delay);
    };

    autoTimerRef.current = window.setTimeout(step, 2200);
  }, [expandGraphFrom]);

  const loadSeed = useCallback(
    async (pmid: string) => {
      const token = ++seedTokenRef.current;
      const startedAt = performance.now();
      setOverlayVisible(true);
      setError(null);
      setSelectedId(null);
      selectedRef.current = null;
      setSelectedDetail(null);

      draggingNodeRef.current = null;
      nodesRef.current = new Map();
      linksRef.current = new Map();
      expandedDepthRef.current = new Map();
      nodeVisualsRef.current = new Map();
      linkVisualsRef.current = new Map();
      autoQueueRef.current = [];
      autoCountRef.current = 0;
      userInteractedRef.current = false;
      framedRef.current = false;
      seedSettledRef.current = false;
      setGraphData({ nodes: [], links: [] });

      try {
        // Main page: the seed's 4-degree neighbourhood (pre-crawled in Neon).
        const data = await fetchGraph(pmid, 4);
        if (token !== seedTokenRef.current) return;
        expandedDepthRef.current.set(pmid, 4);
        mergeGraph(data);

        // Queue un-expanded stubs (closest first) for gentle background growth.
        autoQueueRef.current = data.nodes
          .filter((node) => !node.expanded && node.depth <= 3)
          .sort((a, b) => a.depth - b.depth)
          .map((node) => node.pmid);
        pumpAutoExpand();

        // Let the layout flow into place; keep it centered as it settles, then
        // lock in the zoomed-in framing once the bulk has arranged itself.
        [700, 1800, 3400].forEach((wait) => {
          window.setTimeout(() => {
            if (token === seedTokenRef.current && !userInteractedRef.current && !framedRef.current) {
              graphRef.current?.zoomToFit(650, 40);
            }
          }, wait);
        });
        // The layout has spread by now — from here, additions pin the existing
        // web in place so it grows smoothly instead of reshuffling.
        window.setTimeout(() => {
          if (token === seedTokenRef.current) seedSettledRef.current = true;
        }, 4200);
        window.setTimeout(() => {
          if (token === seedTokenRef.current && !userInteractedRef.current) {
            framedRef.current = true;
            frameGraph(true);
          }
        }, 5200);
      } catch (fetchError) {
        if (token === seedTokenRef.current) {
          setError(fetchError instanceof Error ? fetchError.message : 'Could not build the graph.');
        }
      } finally {
        if (token === seedTokenRef.current) {
          // Hold the loader a beat so a fast cached load doesn't flash.
          const remaining = 900 - (performance.now() - startedAt);
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
          if (token === seedTokenRef.current) setOverlayVisible(false);
        }
      }
    },
    [fetchGraph, mergeGraph, pumpAutoExpand]
  );

  useEffect(() => {
    void loadSeed(seedPmid);
    return () => {
      if (autoTimerRef.current) window.clearTimeout(autoTimerRef.current);
    };
  }, [loadSeed, seedPmid]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    const update = () => setDims({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Restore the saved theme (or follow the OS preference) once on mount.
  useEffect(() => {
    const saved = window.localStorage.getItem('rw-theme') as Theme | null;
    const initial: Theme = saved || (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    setTheme(initial);
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('rw-theme', theme);
  }, [theme]);

  // Every visitor pitches in: quietly ask the server to crawl a few un-expanded
  // articles into Neon. The shared graph grows with traffic and future loads get
  // faster (already-cached info is never re-fetched). Fire-and-forget.
  useEffect(() => {
    let cancelled = false;
    const contribute = () => {
      if (cancelled || document.hidden) return;
      fetch('/api/pubmed/expand?n=2').catch(() => {});
    };
    const timers = [6000, 15000, 26000].map((delay) => window.setTimeout(contribute, delay));
    const interval = window.setInterval(contribute, 45000);
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      window.clearInterval(interval);
    };
  }, []);

  // Live Obsidian-style physics tuned for calm: neighbours follow a dragged
  // node, but the link spring is soft (low strength) so motion glides to rest
  // without overshooting/oscillating — responsive, never jittery.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || graphData.nodes.length === 0) return;
    graph.d3Force('charge')?.strength(-52).distanceMax(320);
    graph.d3Force('link')?.distance(32).strength(0.42);
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
      // Grow at least 3 degrees out from whatever the user last selected.
      void expandGraphFrom(pmid, 3, 40);

      const node = nodesRef.current.get(pmid);
      if (node && graphRef.current && typeof node.x === 'number' && typeof node.y === 'number') {
        graphRef.current.centerAt(node.x, node.y, 600);
      }
    },
    [fetchDetail, expandGraphFrom]
  );

  // Exposed for tests/debugging: select an article as if its node were clicked.
  useEffect(() => {
    (window as unknown as { __rwSelect?: (pmid: string) => void }).__rwSelect = selectArticle;
  }, [selectArticle]);

  const handleDoiSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const value = doiValue.trim();
      if (!value || doiBusy) return;

      setDoiBusy(true);
      setOverlayVisible(true);
      try {
        const response = await fetch(`/api/pubmed/resolve?doi=${encodeURIComponent(value)}`);
        const data = (await response.json()) as { pmid?: string; error?: string };
        if (!response.ok || !data.pmid) throw new Error(data.error || 'Could not resolve the DOI.');
        setDoiValue('');
        await loadSeed(data.pmid);
      } catch (resolveError) {
        setOverlayVisible(false);
        setError(resolveError instanceof Error ? resolveError.message : 'Could not resolve the DOI.');
      } finally {
        setDoiBusy(false);
      }
    },
    [doiValue, doiBusy, loadSeed]
  );

  // ---- Canvas painting -------------------------------------------------

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

  const drawNode = useCallback((node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const hoveredId = hoverRef.current;
    const currentSelectedId = selectedRef.current;
    const isHovered = node.id === hoveredId;
    const isSelected = node.id === currentSelectedId;
    const isNeighborOfHover = hoveredId ? neighborsRef.current.get(hoveredId)?.has(node.id) : false;
    const dimTarget = hoveredId && !isHovered && !isNeighborOfHover && !isSelected ? 1 : 0;

    let visual = nodeVisualsRef.current.get(node.id);
    if (!visual) {
      visual = { a: 0, s: 0.25, hl: 0, dim: 0, la: 0, sel: 0 };
      nodeVisualsRef.current.set(node.id, visual);
    }

    const labelWanted = (isHovered || isSelected || globalScale > 3.6) && dimTarget === 0;
    visual.a = lerp(visual.a, 1, EASE * 0.7); // fade in a touch slower
    visual.s = lerp(visual.s, 1, EASE);
    visual.hl = lerp(visual.hl, isHovered ? 1 : 0, EASE);
    visual.dim = lerp(visual.dim, dimTarget, EASE);
    visual.la = lerp(visual.la, labelWanted ? 1 : 0, EASE);
    visual.sel = lerp(visual.sel, isSelected ? 1 : 0, EASE);

    const degree = degreeRef.current.get(node.id) || 0;
    const baseRadius = 2.2 + Math.min(6, Math.sqrt(degree) * 1.05);
    const radius = baseRadius * visual.s * (1 + 0.38 * visual.hl);
    const x = node.x || 0;
    const y = node.y || 0;

    const { x: cx, y: cy, maxR } = centerRef.current;
    // Ease the radial position so the dense warm core still gives way to cool
    // blues/purples out toward the rim (linear would keep almost everything warm).
    const baseColor = rampColor(Math.pow(Math.hypot(x - cx, y - cy) / maxR, 0.72));
    const color = mix(baseColor, CREAM, visual.sel);
    const alpha = visual.a * (1 - visual.dim * 0.74);

    ctx.save();

    const glowStrength = visual.hl * 0.45 + visual.sel * 0.4;
    if (glowStrength > 0.02) {
      const glow = ctx.createRadialGradient(x, y, radius * 0.4, x, y, radius * 4.4);
      glow.addColorStop(0, rgba(mix(color, CREAM, 0.4), glowStrength * alpha));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius * 4.4, 0, Math.PI * 2);
      ctx.fill();
    }

    const palette = THEME_PALETTE[themeRef.current];

    ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (visual.la > 0.03) {
      const emphasis = Math.max(visual.hl, visual.sel);
      const maxChars = emphasis > 0.5 ? 62 : 34;
      const label = node.title.length > maxChars ? `${node.title.slice(0, maxChars - 1).trim()}…` : node.title;
      const fontSize = 11.5 / globalScale;
      ctx.font = `${emphasis > 0.5 ? 500 : 400} ${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = `rgba(${palette.label}, ${(0.45 + emphasis * 0.5) * visual.la * alpha})`;
      ctx.fillText(label, x, y + radius + 4 / globalScale);
    }

    ctx.restore();
  }, []);

  const drawPointerArea = useCallback((node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
    const degree = degreeRef.current.get(node.id) || 0;
    const radius = 2.2 + Math.min(6, Math.sqrt(degree) * 1.05) + 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x || 0, node.y || 0, radius, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const drawLink = useCallback((link: GraphLink, ctx: CanvasRenderingContext2D) => {
    const source = link.source as GraphNode;
    const target = link.target as GraphNode;
    if (typeof source !== 'object' || typeof target !== 'object') return;

    const sid = source.id;
    const tid = target.id;
    const key = sid < tid ? `${sid}|${tid}` : `${tid}|${sid}`;

    let visual = linkVisualsRef.current.get(key);
    if (!visual) {
      visual = { a: 0, w: 0.55, h: 0 };
      linkVisualsRef.current.set(key, visual);
    }

    const hoveredId = hoverRef.current;
    const currentSelectedId = selectedRef.current;
    const hotHover = hoveredId === sid || hoveredId === tid;
    const hotSelected = currentSelectedId === sid || currentSelectedId === tid;

    let targetAlpha = 0.2;
    let targetWidth = 0.55;
    let targetHeat = 0;
    if (hotHover) {
      targetAlpha = 0.55;
      targetWidth = 1.25;
      targetHeat = 1;
    } else if (hotSelected) {
      targetAlpha = 0.48;
      targetWidth = 1;
      targetHeat = 0.7;
    } else if (hoveredId) {
      targetAlpha = 0.06;
    }

    visual.a = lerp(visual.a, targetAlpha, EASE);
    visual.w = lerp(visual.w, targetWidth, EASE);
    visual.h = lerp(visual.h, targetHeat, EASE);

    const palette = THEME_PALETTE[themeRef.current];
    ctx.strokeStyle = rgba(mix(palette.link, palette.linkHot, visual.h), visual.a);
    ctx.lineWidth = visual.w;
    ctx.beginPath();
    ctx.moveTo(source.x || 0, source.y || 0);
    ctx.lineTo(target.x || 0, target.y || 0);
    ctx.stroke();
  }, []);

  // ---- Draggable card --------------------------------------------------

  const onCardPointerDown = useCallback((event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, .card-body')) return;
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    cardDragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      // pointer may already be inactive — dragging still works via move events
    }
    card.classList.add('dragging');
  }, []);

  const onCardPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = cardDragRef.current;
    const card = cardRef.current;
    if (!drag || !card) return;
    const width = card.offsetWidth;
    const x = Math.min(Math.max(event.clientX - drag.dx, 8 - width * 0.5), window.innerWidth - width * 0.5);
    const y = Math.min(Math.max(event.clientY - drag.dy, 8), window.innerHeight - 48);
    setCardPos({ x, y });
  }, []);

  const onCardPointerUp = useCallback((event: React.PointerEvent) => {
    cardDragRef.current = null;
    const card = cardRef.current;
    if (card) {
      card.classList.remove('dragging');
      try {
        if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
      } catch {
        // no-op
      }
    }
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
      <DotField theme={theme} />

      <div
        className="graph-layer"
        onPointerDown={() => {
          userInteractedRef.current = true;
        }}
        onWheel={() => {
          userInteractedRef.current = true;
        }}
      >
        <ForceGraph2D
          fgRef={graphRef}
          width={dims.width || undefined}
          height={dims.height || undefined}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={drawPointerArea}
          linkCanvasObject={drawLink}
          linkCanvasObjectMode={() => 'replace'}
          autoPauseRedraw={false}
          d3AlphaDecay={0.025}
          d3VelocityDecay={0.6}
          warmupTicks={0}
          cooldownTime={6000}
          onRenderFramePre={updateCentroid}
          onNodeHover={(node: GraphNode | null) => {
            hoverRef.current = node ? node.id : null;
            document.body.style.cursor = node ? 'pointer' : '';
          }}
          onNodeClick={(node: GraphNode) => selectArticle(node.id)}
          onNodeDrag={(node: GraphNode) => {
            // Only direct neighbours follow; the rest of the web is frozen so it
            // can't shimmer. Soft springs make the local follow-motion glide.
            if (draggingNodeRef.current !== node) {
              draggingNodeRef.current = node;
              userInteractedRef.current = true;
              freezeExceptNeighbors(node);
            }
          }}
          onNodeDragEnd={(node: GraphNode) => {
            // Keep the node where it was dropped, then re-freeze everything so
            // the graph is completely still until the next interaction.
            node.fx = node.x;
            node.fy = node.y;
            draggingNodeRef.current = null;
            freezeAll();
          }}
          onBackgroundClick={() => setSelectedId(null)}
          onEngineStop={() => {
            // Keep it centered if physics settles before the framing timer fires.
            if (userInteractedRef.current || framedRef.current) return;
            graphRef.current?.zoomToFit(600, 40);
          }}
        />
      </div>

      <div className="edge-blur" aria-hidden="true" />

      <header className="wordmark">research web</header>

      <button
        className="theme-toggle"
        onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      >
        {theme === 'dark' ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path
              strokeLinecap="round"
              d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          </svg>
        )}
      </button>

      {error ? <div className="error-toast">{error}</div> : null}

      {selectedId && (selectedDetail || selectedNode) ? (
        <aside
          ref={cardRef}
          className="paper-card"
          role="dialog"
          aria-label="Article details"
          style={cardPos ? { left: cardPos.x, top: cardPos.y, right: 'auto', bottom: 'auto' } : undefined}
          onPointerDown={onCardPointerDown}
          onPointerMove={onCardPointerMove}
          onPointerUp={onCardPointerUp}
          onPointerCancel={onCardPointerUp}
        >
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

      <form className="doi-bar" onSubmit={handleDoiSubmit}>
        <input
          className="doi-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste a DOI to grow its research web"
          aria-label="DOI"
          value={doiValue}
          onChange={(event) => setDoiValue(event.target.value)}
          disabled={doiBusy}
        />
        <button className="doi-submit" type="submit" disabled={doiBusy || !doiValue.trim()} aria-label="Build graph">
          →
        </button>
      </form>

      {overlayVisible ? <GraphLoader /> : null}
    </main>
  );
}
