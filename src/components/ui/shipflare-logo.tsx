import Image from 'next/image';

interface ShipFlareLogoProps {
  size?: number;
  className?: string;
}

export function ShipFlareLogo({ size = 20, className }: ShipFlareLogoProps) {
  return (
    <Image
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      style={{ width: 'auto', height: 'auto', maxWidth: size, maxHeight: size }}
      className={className}
      aria-hidden="true"
      priority
    />
  );
}
