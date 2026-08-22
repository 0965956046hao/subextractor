import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";

const outfit = Outfit({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-outfit",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "SubTitle Extractor",
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
          <div className="fixed top-4 right-4 z-[60]">
            <LanguageSwitcher />
          </div>
          <div className="fixed inset-0 pointer-events-none z-50 opacity-[0.18] mix-blend-multiply"
            style={{
              backgroundImage:
                `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            }}
          />
          <div className="relative z-10">{children}</div>
        </I18nProvider>
      </body>
    </html>
  );
}
