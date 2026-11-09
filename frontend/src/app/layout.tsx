import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/session/SessionProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'TwinTrack',
  description: 'Sign in to your TwinTrack modules.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
