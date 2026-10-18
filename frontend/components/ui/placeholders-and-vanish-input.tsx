"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

type Particle = { x: number; y: number; r: number; color: string };

export function PlaceholdersAndVanishInput({
  placeholders,
  onChange,
  onSubmit,
  disabled = false,
}: {
  placeholders: string[];
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
}) {
  const [currentPlaceholder, setCurrentPlaceholder] = useState(0);
  const [value, setValue] = useState("");
  const [animating, setAnimating] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const placeholdersRef = useRef(placeholders);
  placeholdersRef.current = placeholders;

  useEffect(() => {
    const stopAnimation = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
    const startAnimation = () => {
      stopAnimation();
      const items = placeholdersRef.current;
      if (document.visibilityState !== "visible" || items.length < 2) return;
      intervalRef.current = setInterval(() => {
        const count = placeholdersRef.current.length;
        if (count > 0) setCurrentPlaceholder((current) => (current + 1) % count);
      }, 3000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") startAnimation();
      else stopAnimation();
    };
    startAnimation();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopAnimation();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const draw = useCallback(() => {
    const input = inputRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!input || !canvas || !context) return;

    canvas.width = 800;
    canvas.height = 100;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const styles = getComputedStyle(input);
    const fontSize = Number.parseFloat(styles.fontSize);
    context.font = `${fontSize * 2}px ${styles.fontFamily}`;
    context.fillStyle = "#fff";
    context.textBaseline = "middle";
    context.fillText(value, 16, 42, 760);

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const particles: Particle[] = [];
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const pixel = (y * canvas.width + x) * 4;
        if (pixels[pixel + 3] > 0) {
          particles.push({
            x,
            y,
            r: 1,
            color: `rgba(${pixels[pixel]}, ${pixels[pixel + 1]}, ${pixels[pixel + 2]}, ${pixels[pixel + 3] / 255})`,
          });
        }
      }
    }
    particlesRef.current = particles;
  }, [value]);

  useEffect(() => {
    draw();
  }, [draw]);

  const animate = (start: number) => {
    const animateFrame = (position = 0) => {
      frameRef.current = requestAnimationFrame(() => {
        const remaining: Particle[] = [];
        for (const particle of particlesRef.current) {
          if (particle.x < position) {
            remaining.push(particle);
            continue;
          }
          if (particle.r <= 0) continue;
          particle.x += Math.random() > 0.5 ? 1 : -1;
          particle.y += Math.random() > 0.5 ? 1 : -1;
          particle.r -= 0.05 * Math.random();
          if (particle.r > 0) remaining.push(particle);
        }
        particlesRef.current = remaining;
        const context = canvasRef.current?.getContext("2d");
        if (context) {
          context.clearRect(Math.max(position - 10, 0), 0, 820, 120);
          remaining.forEach(({ x, y, r, color }) => {
            if (x >= position) {
              context.fillStyle = color;
              context.fillRect(x, y, r, r);
            }
          });
        }
        if (remaining.length > 0) animateFrame(position - 8);
        else {
          frameRef.current = null;
          setValue("");
          setAnimating(false);
        }
      });
    };
    animateFrame(start);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!value.trim() || disabled || animating) return;
    draw();
    const maxX = particlesRef.current.reduce((max, particle) => Math.max(max, particle.x), 0);
    setAnimating(true);
    animate(maxX);
    onSubmit(event);
  };

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const currentHint = placeholders.length ? placeholders[currentPlaceholder % placeholders.length] : "";

  return (
    <form onSubmit={handleSubmit} className="vanish-input">
      <canvas ref={canvasRef} aria-hidden="true" className={`vanish-input__canvas ${animating ? "is-animating" : ""}`} />
      <input
        ref={inputRef}
        value={value}
        disabled={disabled || animating}
        onChange={(event) => {
          if (animating) return;
          setValue(event.target.value);
          onChange(event);
        }}
        type="text"
        aria-label="Message your agents"
        placeholder=""
        className={`vanish-input__field ${animating ? "is-animating" : ""}`}
      />
      {!value && !disabled && (
        <div className="vanish-input__placeholder" aria-hidden="true">
          <AnimatePresence mode="wait">
            <motion.span
              key={`placeholder-${currentPlaceholder}`}
              initial={{ y: 5, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -12, opacity: 0 }}
              transition={{ duration: 0.25, ease: "linear" }}
            >
              {currentHint}
            </motion.span>
          </AnimatePresence>
        </div>
      )}
      <button type="submit" disabled={!value.trim() || disabled || animating} className="vanish-input__submit" aria-label="Send message">
        <motion.svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <motion.path d="M5 12h14" initial={{ strokeDasharray: "50%", strokeDashoffset: "50%" }} animate={{ strokeDashoffset: value ? 0 : "50%" }} transition={{ duration: 0.3, ease: "linear" }} />
          <path d="m13 6 6 6-6 6" />
        </motion.svg>
      </button>
    </form>
  );
}
