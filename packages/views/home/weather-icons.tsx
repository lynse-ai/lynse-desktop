"use client";

/**
 * Apple-Weather-style condition icons (苹果天气风格的彩色图标) for the
 * Home header's weather block — filled, softly gradient shapes in the
 * iOS Weather palette: golden sun, white cloud shaded toward blue-gray,
 * blue rain, gold bolt. Drawn on a 64 grid; the cloud is unioned from
 * overlapping primitives sharing one `userSpaceOnUse` gradient so the
 * gradient runs continuously across the whole silhouette with no seams.
 * Colors are baked in (not `currentColor`) on purpose — they must read
 * on both light and dark header backgrounds.
 */

interface WeatherIconProps {
  className?: string;
}

/** Shared cloud silhouette — flat rounded bottom, two lobes + tall center. */
function Cloud({ fill }: { fill: string }) {
  return (
    <g fill={fill}>
      <circle cx="20" cy="42" r="11" />
      <circle cx="35" cy="34" r="14" />
      <circle cx="48" cy="42.5" r="10.5" />
      <rect x="20" y="39.5" width="28" height="13.5" rx="6.75" />
    </g>
  );
}

function IconSvg({ className, children }: WeatherIconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Clear sky — sun.max style: gold disc with eight rounded rays. */
export function WxSunIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-sun" x1="16" y1="8" x2="48" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFD426" />
          <stop offset="1" stopColor="#FF9500" />
        </linearGradient>
      </defs>
      <g stroke="url(#lynse-wx-sun)" strokeWidth={5.5} strokeLinecap="round">
        <path d="M32 4v7M32 53v7M4 32h7M53 32h7M12.2 12.2l4.95 4.95M46.85 46.85l4.95 4.95M12.2 51.8l4.95-4.95M46.85 17.15l4.95-4.95" />
      </g>
      <circle cx="32" cy="32" r="14" fill="url(#lynse-wx-sun)" />
    </IconSvg>
  );
}

/** Partly cloudy — cloud.sun style: gold sun peeking over the cloud's top-right. */
export function WxCloudSunIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-sun2" x1="34" y1="2" x2="52" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFD426" />
          <stop offset="1" stopColor="#FF9500" />
        </linearGradient>
        <linearGradient id="lynse-wx-cloud-sun" x1="24" y1="18" x2="40" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
      </defs>
      <g stroke="url(#lynse-wx-sun2)" strokeWidth={4.5} strokeLinecap="round">
        <path d="M42 1.5v4M42 32.5v4M23.5 20h4M56.5 20h4M29.4 7.4l2.8 2.8M51.8 29.8l2.8 2.8M29.4 32.6l2.8-2.8M51.8 10.2l2.8-2.8" />
      </g>
      <circle cx="42" cy="20" r="9" fill="url(#lynse-wx-sun2)" />
      <Cloud fill="url(#lynse-wx-cloud-sun)" />
    </IconSvg>
  );
}

/** Overcast — cloud.fill style: the plain shaded cloud. */
export function WxCloudIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-cloud" x1="24" y1="18" x2="40" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
      </defs>
      <Cloud fill="url(#lynse-wx-cloud)" />
    </IconSvg>
  );
}

/** Fog — cloud.fog style: raised cloud over two rounded bars. */
export function WxFogIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-cloud-fog" x1="24" y1="11" x2="40" y2="47" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
      </defs>
      <g stroke="#B4C3D2" strokeWidth={5} strokeLinecap="round">
        <path d="M14 51.5h36M20 59.5h24" />
      </g>
      <g transform="translate(0 -7)">
        <Cloud fill="url(#lynse-wx-cloud-fog)" />
      </g>
    </IconSvg>
  );
}

/** Rain — cloud.rain style: three slanted blue drops under the raised cloud. */
export function WxRainIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-cloud-rain" x1="24" y1="11" x2="40" y2="47" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
        <linearGradient id="lynse-wx-rain" x1="22" y1="45" x2="42" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#55BEF0" />
          <stop offset="1" stopColor="#1D8FE1" />
        </linearGradient>
      </defs>
      <g stroke="url(#lynse-wx-rain)" strokeWidth={5} strokeLinecap="round">
        <path d="M24 47.5 21 56.5M34 47.5 31 56.5M44 47.5 41 56.5" />
      </g>
      <g transform="translate(0 -7)">
        <Cloud fill="url(#lynse-wx-cloud-rain)" />
      </g>
    </IconSvg>
  );
}

/** Drizzle — lighter rain: shorter, thinner drops. */
export function WxDrizzleIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-cloud-drizzle" x1="24" y1="11" x2="40" y2="47" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
        <linearGradient id="lynse-wx-drizzle" x1="22" y1="45" x2="42" y2="55" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#55BEF0" />
          <stop offset="1" stopColor="#1D8FE1" />
        </linearGradient>
      </defs>
      <g stroke="url(#lynse-wx-drizzle)" strokeWidth={4.5} strokeLinecap="round">
        <path d="M24 47.5l-2 4.5M34 47.5l-2 4.5M44 47.5l-2 4.5" />
      </g>
      <g transform="translate(0 -7)">
        <Cloud fill="url(#lynse-wx-cloud-drizzle)" />
      </g>
    </IconSvg>
  );
}

/** Snow — cloud.snow style: offset rows of soft blue snow dots. */
export function WxSnowIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-cloud-snow" x1="24" y1="11" x2="40" y2="47" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
      </defs>
      <g fill="#A9D6F7">
        <circle cx="21" cy="51.5" r="2.7" />
        <circle cx="32" cy="51.5" r="2.7" />
        <circle cx="43" cy="51.5" r="2.7" />
        <circle cx="26.5" cy="59" r="2.7" />
        <circle cx="37.5" cy="59" r="2.7" />
      </g>
      <g transform="translate(0 -7)">
        <Cloud fill="url(#lynse-wx-cloud-snow)" />
      </g>
    </IconSvg>
  );
}

/** Thunderstorm — cloud.bolt style: gold bolt tucked under the raised cloud. */
export function WxBoltIcon({ className }: WeatherIconProps) {
  return (
    <IconSvg className={className}>
      <defs>
        <linearGradient id="lynse-wx-cloud-bolt" x1="24" y1="11" x2="40" y2="47" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F6F9FC" />
          <stop offset="1" stopColor="#C2CFDE" />
        </linearGradient>
        <linearGradient id="lynse-wx-bolt" x1="30" y1="42" x2="36" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFD426" />
          <stop offset="1" stopColor="#FF9500" />
        </linearGradient>
      </defs>
      <path d="M34.5 43 25.5 57h6.5L28.5 63.5 40 49.5h-7l4.5-6.5Z" fill="url(#lynse-wx-bolt)" />
      <g transform="translate(0 -7)">
        <Cloud fill="url(#lynse-wx-cloud-bolt)" />
      </g>
    </IconSvg>
  );
}

/** WMO code → Apple-style condition icon (unknown codes fall back to cloud). */
export function appleWeatherIcon(code: number): (props: WeatherIconProps) => React.JSX.Element {
  if (code === 0) return WxSunIcon;
  if (code === 1 || code === 2) return WxCloudSunIcon;
  if (code === 3) return WxCloudIcon;
  if (code === 45 || code === 48) return WxFogIcon;
  if (code >= 51 && code <= 57) return WxDrizzleIcon;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return WxRainIcon;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return WxSnowIcon;
  if (code >= 95) return WxBoltIcon;
  return WxCloudIcon;
}
