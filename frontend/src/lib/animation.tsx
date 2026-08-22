"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * IntersectionObserver hook — triggers once when element enters viewport.
 */
export function useInView(threshold = 0.1) {
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
      { threshold, rootMargin: "0px 0px -40px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

/**
 * Premium scroll-entry animation block.
 * Spring-physics cubic-bezier, blur-to-clear, translateY + scale.
 */
export function AnimatedBlock({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
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
        transform: "translateY(28px) scale(0.97)",
        filter: "blur(4px)",
        transition: `opacity 0.85s cubic-bezier(0.32,0.72,0,1) ${delay}ms, transform 0.85s cubic-bezier(0.32,0.72,0,1) ${delay}ms, filter 0.7s cubic-bezier(0.32,0.72,0,1) ${delay}ms`,
        ...(inView
          ? {
              opacity: 1,
              transform: "translateY(0) scale(1)",
              filter: "blur(0)",
            }
          : {}),
      }}
    >
      {children}
    </div>
  );
}

/**
 * Staggered children — each child fades in with incremental delay.
 */
export function StaggerGroup({
  children,
  baseDelay = 0,
  stagger = 60,
  className = "",
}: {
  children: ReactNode;
  baseDelay?: number;
  stagger?: number;
  className?: string;
}) {
  const { ref, inView } = useInView();
  const items = Array.isArray(children) ? children : [children];
  return (
    <div ref={ref} className={className}>
      {items.map((child, i) => (
        <div
          key={i}
          style={{
            opacity: 0,
            transform: "translateY(20px)",
            transition: `opacity 0.7s cubic-bezier(0.32,0.72,0,1) ${baseDelay + i * stagger}ms, transform 0.7s cubic-bezier(0.32,0.72,0,1) ${baseDelay + i * stagger}ms`,
            ...(inView
              ? { opacity: 1, transform: "translateY(0)" }
              : {}),
          }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
