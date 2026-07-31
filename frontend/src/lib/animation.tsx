"use client";

import { useEffect, useRef, useState } from "react";

export function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

export function AnimatedBlock({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: 0,
        transform: "translateY(32px) scale(0.98)",
        filter: "blur(6px)",
        transition: `all 0.9s cubic-bezier(0.32,0.72,0,1) ${delay}ms`,
        ...(inView
          ? { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0)" }
          : {}),
      }}
    >
      {children}
    </div>
  );
}
