'use client';

import { useEffect, useRef } from 'react';

const SPACING = 30;
const DOT_RADIUS = 1.1;
const INFLUENCE = 130;
const PUSH = 26;
const EASE = 0.12;

type Dot = { hx: number; hy: number; x: number; y: number };

/**
 * A faint grey grid of dots behind the graph that gently parts around the
 * cursor and eases back — a soft, living backdrop rather than a flat void.
 */
export default function DotField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999 };
    let frame = 0;

    const build = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      dots = [];
      const cols = Math.ceil(width / SPACING) + 1;
      const rows = Math.ceil(height / SPACING) + 1;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const hx = col * SPACING;
          const hy = row * SPACING;
          dots.push({ hx, hy, x: hx, y: hy });
        }
      }
    };

    const render = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      const breathe = time * 0.00045;
      for (let index = 0; index < dots.length; index += 1) {
        const dot = dots[index];
        const dx = dot.x - mouse.x;
        const dy = dot.y - mouse.y;
        const dist = Math.hypot(dx, dy);

        let targetX = dot.hx;
        let targetY = dot.hy;
        let glow = 0;
        if (dist < INFLUENCE && dist > 0.001) {
          const force = (1 - dist / INFLUENCE) * PUSH;
          targetX = dot.hx + (dx / dist) * force;
          targetY = dot.hy + (dy / dist) * force;
          glow = 1 - dist / INFLUENCE;
        }

        dot.x += (targetX - dot.x) * EASE;
        dot.y += (targetY - dot.y) * EASE;

        // Slow per-dot shimmer keeps the field feeling alive even when idle.
        const twinkle = Math.sin(breathe + dot.hx * 0.021 + dot.hy * 0.017) * 0.05;
        const alpha = Math.max(0.06, 0.15 + twinkle + glow * 0.5);
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, DOT_RADIUS + glow * 0.9, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(196, 176, 150, ${alpha})`;
        ctx.fill();
      }
      frame = requestAnimationFrame(render);
    };

    // Capture-phase pointermove: d3-drag stops propagation while a node is
    // being dragged, which starves bubble-phase listeners — capture still
    // fires, so the field keeps responding mid-drag.
    const onMove = (event: PointerEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
    };
    const onLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    build();
    frame = requestAnimationFrame(render);
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', onMove, { capture: true, passive: true });
    document.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    window.addEventListener('resize', build);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointerdown', onMove, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('resize', build);
    };
  }, []);

  return <canvas ref={canvasRef} className="dot-field" aria-hidden="true" />;
}
