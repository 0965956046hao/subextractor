import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import AppShell from "@/components/layout/AppShell";

const outfit = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-outfit",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "SubTitle Studio",
  description:
    "Extract subtitle text from any video using OCR — upload, select region, download SRT.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className="font-sans text-ink antialiased min-h-[100dvh] bg-paper">
        <I18nProvider>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
