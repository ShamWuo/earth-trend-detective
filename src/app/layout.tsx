import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Outfit, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Earth Trend Detective · NASA Space Apps ETG Observatory",
  description:
    "Detect, statistically verify (Mann-Kendall & Theil-Sen), and corroborate Earth & climate trends across an interactive 3D Earth globe and AI-native Earth Trend Graph.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const THEME_INIT_SCRIPT = `(function () {
  try {
    var stored = localStorage.getItem("color-scheme");
    var override = stored === "light" || stored === "dark" ? stored : null;
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta && override) {
      meta.content = override;
    }
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = override || (prefersDark ? "dark" : "light");
    document.documentElement.classList.toggle("light", resolved === "light");
  } catch (_) {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plusJakarta.variable} ${outfit.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="antialiased overflow-x-hidden">{children}</body>
    </html>
  );
}
