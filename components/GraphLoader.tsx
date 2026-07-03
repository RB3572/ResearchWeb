'use client';

import { useEffect, useState } from 'react';
import SiriWave from './SiriWave';

const MESSAGES = ['resolving identifiers', 'gathering citations', 'weaving the web', 'placing nodes'];

type GraphLoaderProps = {
  label?: string;
};

export default function GraphLoader({ label }: GraphLoaderProps) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMessageIndex((index) => (index + 1) % MESSAGES.length);
    }, 1600);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="graph-loader" role="status" aria-label="Building research web">
      <div className="loader-orb">
        <SiriWave variant="fluid-dots" size={360} renderScale={0.9} className="loader-shader" />
      </div>
      <p className="loader-text">{label || MESSAGES[messageIndex]}…</p>
    </div>
  );
}
