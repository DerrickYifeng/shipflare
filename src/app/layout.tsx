import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    template: '%s · ShipFlare',
    default: 'ShipFlare',
  },
  description: 'AI marketing autopilot for indie developers',
  icons: {
    icon: [
      { url: '/logo-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/logo-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
