"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import gsap from "gsap";

const ROWS = 5;
const STAGGER_DELAY = 0.12;
const COVER_DURATION = 0.72;
const REVEAL_DURATION = 0.68;
const BLOCK_OFFSET_PERCENT = 101;
const SHIFT_SCALE_OUT = 0.98;
const SHIFT_SCALE_IN = 1.02;
const SHIFT_BLUR = "4px";
const SHIFT_DURATION_OUT = 0.7;
const SHIFT_DURATION_IN = 0.8;
const REDUCED_MOTION_FADE = 0.2;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

export interface BlockTransitionProps {
  transitionKey: string | number;
  children?: ReactNode;
  enableContentShift?: boolean;
  rows?: number;
  color?: string;
  duration?: number;
  onComplete?: () => void;
  className?: string;
}

export default function BlockTransition({
  transitionKey,
  children,
  enableContentShift = false,
  rows = ROWS,
  color,
  duration = 1,
  onComplete,
  className = "",
}: BlockTransitionProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const coveringRef = useRef(false);
  const revealedRevisionRef = useRef(0);
  const shownChildrenRef = useRef<ReactNode>(children);
  const latestRef = useRef({ transitionKey, onComplete });
  latestRef.current = { transitionKey, onComplete };

  const [view, setView] = useState({ key: transitionKey, revision: 0 });
  const safeRows = Math.round(clampNumber(rows, 2, 12, ROWS));
  const safeDuration = clampNumber(duration, 0.25, 3, 1);
  const isLeaving = transitionKey !== view.key;
  if (!isLeaving) shownChildrenRef.current = children;

  const getRows = () => rowRefs.current.slice(0, safeRows).filter(Boolean) as HTMLDivElement[];
  const animationConfigRef = useRef({ enableContentShift, safeDuration });
  animationConfigRef.current = { enableContentShift, safeDuration };
  const buildRowsAnimationRef = useRef<(timeline: gsap.core.Timeline, direction: "cover" | "reveal") => void>(() => {});

  const buildRowsAnimation = (timeline: gsap.core.Timeline, direction: "cover" | "reveal") => {
    const blockRows = getRows();
    const orderedRows = direction === "cover" ? blockRows : [...blockRows].reverse();

    orderedRows.forEach((row, index) => {
      const [leftBlock, rightBlock] = Array.from(row.children);
      const delay = index * STAGGER_DELAY;
      if (direction === "cover") {
        timeline.set([leftBlock, rightBlock], { autoAlpha: 1 }, delay);
        timeline.to([leftBlock, rightBlock], {
          xPercent: 0,
          duration: COVER_DURATION * safeDuration,
          ease: "power3.inOut",
        }, delay);
      } else {
        timeline.to(leftBlock, {
          xPercent: -BLOCK_OFFSET_PERCENT,
          duration: REVEAL_DURATION * safeDuration,
          ease: "power3.inOut",
        }, delay);
        timeline.set(leftBlock, { autoAlpha: 0 }, delay + REVEAL_DURATION * safeDuration);
        timeline.to(rightBlock, {
          xPercent: BLOCK_OFFSET_PERCENT,
          duration: REVEAL_DURATION * safeDuration,
          ease: "power3.inOut",
        }, delay);
        timeline.set(rightBlock, { autoAlpha: 0 }, delay + REVEAL_DURATION * safeDuration);
      }
    });
  };
  buildRowsAnimationRef.current = buildRowsAnimation;

  useIsomorphicLayoutEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, safeRows);
    getRows().forEach((row) => {
      const [leftBlock, rightBlock] = Array.from(row.children);
      if (!leftBlock || !rightBlock) return;
      gsap.set(leftBlock, { xPercent: -BLOCK_OFFSET_PERCENT, autoAlpha: 0 });
      gsap.set(rightBlock, { xPercent: BLOCK_OFFSET_PERCENT, autoAlpha: 0 });
    });
  }, [safeRows]);

  useEffect(() => {
    if (transitionKey === view.key || coveringRef.current) return;
    coveringRef.current = true;
    timelineRef.current?.kill();

    const timeline = gsap.timeline({
      onComplete: () => {
        coveringRef.current = false;
        setView((current) => ({
          key: latestRef.current.transitionKey,
          revision: current.revision + 1,
        }));
      },
    });
    timelineRef.current = timeline;

    if (prefersReducedMotion()) {
      timeline.to(wrapperRef.current, { opacity: 0, duration: REDUCED_MOTION_FADE, ease: "power1.out" }, 0);
      return;
    }

    const { enableContentShift: shiftContent, safeDuration: currentDuration } = animationConfigRef.current;
    if (shiftContent) {
      timeline.fromTo(wrapperRef.current,
        { scale: 1, filter: "blur(0px)", opacity: 1 },
        { scale: SHIFT_SCALE_OUT, filter: `blur(${SHIFT_BLUR})`, opacity: 0.85, duration: SHIFT_DURATION_OUT * currentDuration, ease: "power2.inOut" },
        0,
      );
    }
    buildRowsAnimationRef.current(timeline, "cover");
  }, [transitionKey, view.key]);

  useIsomorphicLayoutEffect(() => {
    if (view.revision === revealedRevisionRef.current) return;
    revealedRevisionRef.current = view.revision;
    timelineRef.current?.kill();
    const wrapper = wrapperRef.current;
    if (wrapper && (!document.activeElement || document.activeElement === document.body)) {
      wrapper.focus({ preventScroll: true });
    }

    const timeline = gsap.timeline({ onComplete: () => latestRef.current.onComplete?.() });
    timelineRef.current = timeline;
    if (prefersReducedMotion()) {
      timeline.to(wrapper, { opacity: 1, duration: REDUCED_MOTION_FADE, ease: "power1.out", clearProps: "opacity" }, 0);
      return;
    }
    const { enableContentShift: shiftContent, safeDuration: currentDuration } = animationConfigRef.current;
    if (shiftContent) {
      timeline.fromTo(wrapper,
        { scale: SHIFT_SCALE_IN, filter: `blur(${SHIFT_BLUR})`, opacity: 0.85 },
        { scale: 1, filter: "blur(0px)", opacity: 1, duration: SHIFT_DURATION_IN * currentDuration, ease: "power2.out", clearProps: "transform,filter,opacity" },
        0.08,
      );
    }
    buildRowsAnimationRef.current(timeline, "reveal");
  }, [view.revision]);

  useEffect(() => {
    return () => {
      timelineRef.current?.kill();
    };
  }, []);

  const blockClassName = `absolute top-0 h-full w-[51%] will-change-transform ${color ? "" : "bg-foreground"}`;
  const blockStyle = { backgroundColor: color, opacity: 0, visibility: "hidden" as const };

  return (
    <div className={`relative min-h-0 min-w-0 ${className}`}>
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden" style={{ zIndex: 9999 }}>
        {Array.from({ length: safeRows }, (_, index) => (
          <div key={index} ref={(node) => { rowRefs.current[index] = node; }} className="absolute left-0 w-full overflow-hidden"
            style={{ top: `${(index * 100) / safeRows}%`, height: `calc(${100 / safeRows}% + 2px)` }}>
            <span className={`${blockClassName} left-0`} style={blockStyle} />
            <span className={`${blockClassName} right-0`} style={blockStyle} />
          </div>
        ))}
      </div>
      <div ref={wrapperRef} tabIndex={-1} aria-busy={isLeaving || undefined} className="min-w-0 outline-none">
        {isLeaving ? shownChildrenRef.current : children}
      </div>
    </div>
  );
}
