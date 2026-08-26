"use client";

import { useState } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { RiArrowDownSLine } from "@remixicon/react";

export default function CollapsibleSection({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="mb-6">
        <CollapsibleTrigger className="w-full flex items-center gap-2.5 py-2 cursor-pointer select-none text-left group">
          <RiArrowDownSLine
            size={17}
            className={`flex-shrink-0 text-ink-light transition-transform duration-300 ${
              open ? "" : "-rotate-90"
            }`}
          />
          <span
            className={`text-[12px] font-semibold uppercase tracking-[0.13em] whitespace-nowrap transition-colors duration-200 ${
              open ? "text-accent-light" : "text-ink-muted group-hover:text-ink"
            }`}
          >
            {title}
          </span>
          <span className="h-px flex-1 bg-white/[0.07]" />
          {hint && (
            <span className="tag hidden sm:inline-flex flex-shrink-0">{hint}</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-4">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
