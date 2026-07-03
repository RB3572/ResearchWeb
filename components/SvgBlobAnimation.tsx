'use client';

/**
 * A very subtle, slow-drifting field of soft blobs behind everything — Monet
 * dusk tones, heavily blurred and low-opacity so it reads as ambient light
 * rather than a graphic. Adapted to be calmer/less vibrant than the original.
 */
export default function SvgBlobAnimation() {
  return (
    <div className="blob-field" aria-hidden="true">
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="blob-gold" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f6b45a" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#f6b45a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="blob-rose" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c95b60" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#c95b60" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="blob-plum" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#8c5c94" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#8c5c94" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="blob-teal" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#487098" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#487098" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g className="blob blob-a">
          <ellipse cx="320" cy="360" rx="320" ry="300" fill="url(#blob-gold)" />
        </g>
        <g className="blob blob-b">
          <ellipse cx="700" cy="300" rx="300" ry="320" fill="url(#blob-rose)" />
        </g>
        <g className="blob blob-c">
          <ellipse cx="640" cy="720" rx="340" ry="300" fill="url(#blob-plum)" />
        </g>
        <g className="blob blob-d">
          <ellipse cx="300" cy="700" rx="300" ry="320" fill="url(#blob-teal)" />
        </g>
      </svg>
    </div>
  );
}
