import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chalupa Všetice | Váš kousek venkova",
  description: "Chalupa se zahradou, bazénem a krbem ve Všeticích. Prohlédněte si vybavení, ceny a kalendář obsazenosti.",
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
