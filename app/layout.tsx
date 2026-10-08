import type { Metadata } from "next";
import { cs } from "../lib/i18n/messages/cs.ts";
import "./globals.css";

// Statický HTML je předrenderovaný česky; po přepnutí jazyka titulek a popis aktualizuje
// I18nProvider v prohlížeči.
export const metadata: Metadata = {
  title: cs["meta.title"],
  description: cs["meta.description"],
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs">
      <body className="antialiased">{children}</body>
    </html>
  );
}
