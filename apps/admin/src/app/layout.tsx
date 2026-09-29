import type { Metadata, Viewport } from "next";
import "@chatbase/ui/globals.css";

export const metadata: Metadata = {
  title: "Chatbase India admin",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
