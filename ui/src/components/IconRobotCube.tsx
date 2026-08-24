import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

/** Blue robot holding a rotating magic cube — loops forever. */
export function IconRobotCube({ size = 28, className, ...rest }: Props) {
  const id = "rk";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={`icon-robot-cube ${className || ""}`.trim()}
      aria-hidden
      {...rest}
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="12" y1="10" x2="52" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5B9DFF" />
          <stop offset="1" stopColor="#2F6FED" />
        </linearGradient>
        <linearGradient id={`${id}-cube`} x1="36" y1="8" x2="58" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8EC5FF" />
          <stop offset="1" stopColor="#3B82F6" />
        </linearGradient>
      </defs>

      {/* antenna */}
      <g className="rc-antenna">
        <line x1="32" y1="10" x2="32" y2="16" stroke="#2F6FED" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="32" cy="8" r="2.4" fill="#6BA0FF" />
      </g>

      {/* head / body */}
      <rect x="16" y="16" width="32" height="28" rx="8" fill={`url(#${id}-body)`} />
      <rect x="20" y="22" width="24" height="12" rx="4" fill="#EAF2FF" opacity="0.95" />
      <g className="rc-eyes">
        <circle cx="27" cy="28" r="2.2" fill="#1E3A8A" />
        <circle cx="37" cy="28" r="2.2" fill="#1E3A8A" />
      </g>
      <path d="M26 34.5c2.2 2 9.8 2 12 0" stroke="#1E3A8A" strokeWidth="1.8" strokeLinecap="round" />

      {/* arms */}
      <path d="M16 30c-5 2-7 8-5 12" stroke="#2F6FED" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M48 28c4-1 9 2 10 7" stroke="#2F6FED" strokeWidth="3.2" strokeLinecap="round" />

      {/* rotating cube in hand */}
      <g className="rc-cube" transform="translate(46 18)">
        <g className="rc-cube-spin">
          <path d="M0 6 L8 1 L16 6 L8 11 Z" fill={`url(#${id}-cube)`} />
          <path d="M0 6 L8 11 L8 19 L0 14 Z" fill="#2563EB" />
          <path d="M16 6 L8 11 L8 19 L16 14 Z" fill="#1D4ED8" />
          <path d="M0 6 L8 1 L16 6 L8 11 Z" stroke="#DBEAFE" strokeWidth="0.6" opacity="0.7" />
        </g>
      </g>

      {/* legs */}
      <path d="M24 44v8M40 44v8" stroke="#2F6FED" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="24" cy="54" r="2.4" fill="#6BA0FF" />
      <circle cx="40" cy="54" r="2.4" fill="#6BA0FF" />
    </svg>
  );
}
