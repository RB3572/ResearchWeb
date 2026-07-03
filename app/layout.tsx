import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ResearchWeb',
  description: 'A minimal graph interface for exploring PubMed papers and their reference networks.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
