type Props = {
  size?: number;
  className?: string;
};

/** Circular 星徽 — star in a ring, used beside the wordmark. */
export function BrandMark({ size = 32, className = "" }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={`brand-icon ${className}`.trim()}
      aria-hidden
    >
      <circle cx="32" cy="32" r="30" className="brand-ring" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="32" cy="32" r="25.2" className="brand-disc" fill="currentColor" />
      <circle cx="32" cy="32" r="25.2" className="brand-disc-rim" />
      <g className="brand-wings">
        <rect x="11.2" y="29.2" width="7.6" height="1.55" rx="0.7" />
        <rect x="12.4" y="32.25" width="6.4" height="1.35" rx="0.65" />
        <rect x="13.6" y="35.05" width="5.2" height="1.2" rx="0.6" />
        <rect x="45.2" y="29.2" width="7.6" height="1.55" rx="0.7" />
        <rect x="45.2" y="32.25" width="6.4" height="1.35" rx="0.65" />
        <rect x="45.2" y="35.05" width="5.2" height="1.2" rx="0.6" />
      </g>
      <path
        className="brand-star"
        d="M32 14.2 L35.55 26.15 L48.2 26.5 L38.15 34 L41.7 46.2 L32 39.35 L22.3 46.2 L25.85 34 L15.8 26.5 L28.45 26.15 Z"
      />
    </svg>
  );
}
