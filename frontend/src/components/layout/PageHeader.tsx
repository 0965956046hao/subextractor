"use client";

import Link from "next/link";
import { AnimatedBlock } from "@/lib/animation";

export default function PageHeader({
  title,
  description,
  badge,
  actions,
  back,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <AnimatedBlock delay={0}>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-7">
        <div className="min-w-0">
          {back && (
            <Link
              href={back.href}
              className="inline-flex items-center gap-1.5 mb-3 text-[12px] font-medium text-ink-muted hover:text-accent-light transition-colors cursor-pointer"
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 12H5" />
                <path d="M11 18l-6-6 6-6" />
              </svg>
              {back.label}
            </Link>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl lg:text-[1.35rem] font-semibold tracking-tight leading-tight text-ink break-words">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1.5 text-[13px] text-ink-muted max-w-2xl leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
            {actions}
          </div>
        )}
      </div>
    </AnimatedBlock>
  );
}
