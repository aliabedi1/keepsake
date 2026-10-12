import type { Metadata } from "next";
import { DM_Sans, Playfair_Display } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./theme.css";

const themeScript = `try{const theme=localStorage.getItem("keepsake-color-theme");if(theme==="light"||theme==="dark")document.documentElement.dataset.theme=theme}catch{}`;

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export async function generateMetadata(): Promise<Metadata> {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") || headerStore.get("host");
  const protocol = headerStore.get("x-forwarded-proto") || "https";
  const origin = host ? `${protocol}://${host}` : "http://localhost:3000";
  const title = "Keepsake — Local Instagram Archiver";
  const description =
    "Keep a validated local Instagram highlight and post library, and export saved files whenever you need them.";

  return {
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${dmSans.variable} ${playfair.variable}`}>{children}</body>
    </html>
  );
}
