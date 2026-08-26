"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  RiFilmLine,
  RiMovieLine,
  RiFlashlightLine,
  RiScissorsCutLine,
  RiTv2Line,
  RiSettings3Line,
  RiMenuLine,
  RiCloseLine,
  RiArrowLeftDoubleLine,
  RiArrowRightDoubleLine,
} from "@remixicon/react";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { useI18n } from "@/lib/i18n";

type NavItem = {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
};

type NavGroup = {
  labelKey: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "nav.group.workspace",
    items: [
      { href: "/", labelKey: "nav.library", icon: RiFilmLine },
      {
        href: "/library/pipeline",
        labelKey: "nav.library.pipeline",
        icon: RiMovieLine,
      },
    ],
  },
  {
    labelKey: "nav.group.tools",
    items: [
      { href: "/extract", labelKey: "nav.extract", icon: RiScissorsCutLine },
      { href: "/auto", labelKey: "nav.auto", icon: RiFlashlightLine },
      { href: "/channels", labelKey: "nav.channels", icon: RiTv2Line },
    ],
  },
  {
    labelKey: "nav.group.system",
    items: [
      { href: "/settings", labelKey: "nav.settings", icon: RiSettings3Line },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <div
      className={`w-8 h-8 rounded-lg bg-accent flex items-center justify-center flex-shrink-0 ${className}`}
    >
      <svg
        className="w-4 h-4 text-white"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="4" width="20" height="16" rx="3" />
        <line x1="2" y1="9" x2="22" y2="9" />
        <path d="M11 13l3 1.5-3 1.5v-3z" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [rail, setRail] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      setRail(localStorage.getItem("shell.rail") === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggleRail = useCallback(() => {
    setRail((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("shell.rail", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const sidebarWidth = rail ? 68 : 236;

  const nav = (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div
        className={`flex items-center h-14 flex-shrink-0 border-b border-white/[0.06] ${
          rail ? "justify-center px-2" : "px-4 gap-3"
        }`}
      >
        <Link href="/" className="flex items-center gap-3 min-w-0 cursor-pointer">
          <BrandMark />
          {!rail && (
            <span className="text-[13px] font-semibold tracking-tight text-ink truncate">
              SubTitle<span className="text-accent-light">Studio</span>
            </span>
          )}
        </Link>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin py-4 px-2.5 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.labelKey}>
            {!rail && (
              <p className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-light/70">
                {t(group.labelKey as string)}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={t(item.labelKey as string)}
                    className={`relative flex items-center rounded-lg text-[13px] font-medium tracking-tight cursor-pointer
                      transition-colors duration-200 ${
                        rail ? "justify-center h-10 w-full" : "gap-3 px-2.5 h-9"
                      } ${
                        active
                          ? "bg-accent-muted text-accent-light"
                          : "text-ink-muted hover:text-ink hover:bg-white/[0.05]"
                      }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-accent-light" />
                    )}
                    <Icon size={rail ? 19 : 17} className="flex-shrink-0" />
                    {!rail && (
                      <span className="truncate">{t(item.labelKey as string)}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-white/[0.06] p-2.5 space-y-2">
        <div className={rail ? "flex justify-center" : ""}>
          <LanguageSwitcher compact={rail} />
        </div>
        <button
          onClick={toggleRail}
          aria-label={
            rail ? t("nav.expand" as string) : t("nav.collapse" as string)
          }
          title={rail ? t("nav.expand" as string) : t("nav.collapse" as string)}
          className={`hidden lg:flex items-center rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink hover:bg-white/[0.05] transition-colors cursor-pointer ${
            rail ? "h-9 w-full justify-center" : "gap-2.5 px-2.5 h-8"
          }`}
        >
          {rail ? (
            <RiArrowRightDoubleLine size={17} />
          ) : (
            <>
              <RiArrowLeftDoubleLine size={17} />
              <span>{t("nav.collapse" as string)}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="min-h-[100dvh] lg:pl-[var(--shell-w)] transition-[padding] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={
        { "--shell-w": `${sidebarWidth}px` } as React.CSSProperties
      }
    >
      {/* ── Desktop sidebar ── */}
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden lg:block overflow-hidden bg-rail border-r border-white/[0.06] transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{ width: sidebarWidth }}
      >
        {nav}
      </aside>

      {/* ── Mobile drawer ── */}
      <aside
        className={`fixed inset-y-0 left-0 z-[70] w-[260px] lg:hidden bg-rail border-r border-white/[0.08] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          onClick={() => setMobileOpen(false)}
          aria-label={t("btn.cancel" as string)}
          className="absolute top-3.5 right-3 z-10 w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <RiCloseLine size={18} />
        </button>
        {nav}
      </aside>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[60] lg:hidden bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Content column ── */}
      <div className="flex min-h-[100dvh] flex-col">
        {/* Mobile top bar */}
        <header className="lg:hidden sticky top-0 z-50 flex items-center gap-3 h-14 px-4 bg-glass backdrop-blur-xl border-b border-white/[0.06]">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label={t("nav.menu" as string)}
            className="w-9 h-9 -ml-2 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <RiMenuLine size={19} />
          </button>
          <BrandMark className="!w-7 !h-7" />
          <span className="text-[13px] font-semibold tracking-tight text-ink">
            SubTitle<span className="text-accent-light">Studio</span>
          </span>
          <div className="ml-auto">
            <LanguageSwitcher />
          </div>
        </header>

        <main className="w-full flex-1 px-4 sm:px-6 py-6 lg:px-8 xl:px-10 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
