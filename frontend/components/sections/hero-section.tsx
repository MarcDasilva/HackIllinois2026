"use client";

import { useRef, useState } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import { ChevronDown } from "lucide-react";
import MetallicPaint from "@/components/MetallicPaint";

const images = [
  "/premium_photo-1670573801174-1ab41ec2afa0.avif",
  "/bigstock-Businessman-Or-Accountant-Work-BW_small.jpg",
  "/new-york-skyline-art-bw.jpg",
];

/** Matte gold used for Velum wordmark and accent text - single source of truth */
const VELUM_GOLD = "#b8a060";

const LANDING_BG_IMAGE = "/bg.png";

function landingBgUrl() {
  return `url("${encodeURI(LANDING_BG_IMAGE)}")`;
}

/** White Google "G" logo for Sign in with Google button */
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="currentColor"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="currentColor"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="currentColor"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function HeroSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [metallicReady, setMetallicReady] = useState(false);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end start"],
  });

  const rotate1 = useTransform(scrollYProgress, [0, 1], [-6, 0]);
  const rotate2 = useTransform(scrollYProgress, [0, 1], [0, 0]);
  const rotate3 = useTransform(scrollYProgress, [0, 1], [6, 0]);
  const x1 = useTransform(scrollYProgress, [0, 1], [-80, 0]);
  const x3 = useTransform(scrollYProgress, [0, 1], [80, 0]);
  const y = useTransform(scrollYProgress, [0, 1], [0, 100]);
  const ySide = useTransform(y, (v) => (v as number) + 48);

  return (
    <section
      ref={containerRef}
      className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden bg-background px-6 -mt-8 pt-0 pb-0 gap-1"
    >
      {/* Background: black base + screenshot on top */}
      <div
        className="absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: landingBgUrl(),
        }}
        aria-hidden
      />
      {/* Logo emblem and wordmark above cards */}
      <div className="relative z-10 flex items-center justify-center gap-12 md:gap-16 shrink-0">
        <a
          href="#"
          className="text-lg font-serif text-muted-foreground hover:text-foreground transition-colors shrink-0"
          data-clickable
        >
          The Wall
        </a>
        <div className="flex flex-col items-center justify-center gap-2 pointer-events-none">
          <div className="w-[min(24vmin,140px)] h-[min(24vmin,140px)] md:w-[min(16vmin,120px)] md:h-[min(16vmin,120px)] relative">
            {/* Static placeholder until metallic effect is ready — avoids flash on load */}
            <img
              src="/velumclear.png"
              alt=""
              className="absolute inset-0 w-full h-full object-contain"
              style={{ opacity: metallicReady ? 0 : 1, transition: "opacity 0.25s ease-out", pointerEvents: "none" }}
              aria-hidden
            />
            <MetallicPaint
              imageSrc="/velumclear.png"
              scale={3.5}
              refraction={0.012}
              liquid={0.7}
              speed={0.25}
              brightness={2}
              lightColor="#ffffff"
              darkColor="#000000"
              fresnel={1}
              onReady={() => setMetallicReady(true)}
            />
          </div>
          <span className="text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight font-serif" style={{ color: VELUM_GOLD }}>
            Velum
          </span>
        </div>
        <a
          href="#pricing"
          className="text-lg font-serif text-muted-foreground hover:text-foreground transition-colors shrink-0"
          data-clickable
        >
          Pricing
        </a>
      </div>

      <div className="relative z-10 flex items-center justify-center min-h-[420px] md:min-h-[480px]">
        <motion.div
          className="absolute w-[280px] md:w-[320px] aspect-[3/4] rounded-xl overflow-hidden shadow-2xl"
          style={{ rotate: rotate1, x: x1, y: ySide, zIndex: 1 }}
          initial={{ clipPath: "inset(100% 0 0 0)" }}
          animate={{ clipPath: "inset(0 0 0 0)" }}
          transition={{ duration: 1, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <img
            src={images[0]}
            alt="Showcase 1"
            className="w-full h-full object-cover"
          />
        </motion.div>

        <motion.div
          className="relative w-[280px] md:w-[320px] aspect-[3/4] rounded-xl overflow-hidden shadow-2xl"
          style={{ rotate: rotate2, y, zIndex: 2 }}
          initial={{ clipPath: "inset(100% 0 0 0)" }}
          animate={{ clipPath: "inset(0 0 0 0)" }}
          transition={{ duration: 1, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <img
            src={images[1]}
            alt="Showcase 2"
            className="w-full h-full object-cover"
          />
        </motion.div>

        <motion.div
          className="absolute w-[280px] md:w-[320px] aspect-[3/4] rounded-xl overflow-hidden shadow-2xl"
          style={{ rotate: rotate3, x: x3, y: ySide, zIndex: 1 }}
          initial={{ clipPath: "inset(100% 0 0 0)" }}
          animate={{ clipPath: "inset(0 0 0 0)" }}
          transition={{ duration: 1, delay: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <img
            src={images[2]}
            alt="Showcase 3"
            className="w-full h-full object-cover"
          />
        </motion.div>
      </div>

      <motion.div
        className="absolute inset-0 flex flex-col items-center justify-center gap-8 z-10 pt-24 md:pt-32"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, delay: 0.8 }}
      >
        <h1 className="text-5xl md:text-7xl lg:text-8xl font-serif text-center text-foreground mix-blend-difference pointer-events-none">
          Documents stay <em className="italic font-serif font-bold tracking-tight mix-blend-normal" style={{ color: VELUM_GOLD, WebkitTextStroke: '4px white', paintOrder: 'stroke fill' }}>Yours</em>
        </h1>
        <a
          href="#"
          className="inline-flex items-center gap-2.5 px-6 py-3 rounded-3xl bg-black border-2 border-white text-white text-lg font-medium hover:bg-white hover:text-black transition-colors pointer-events-auto [&_svg]:text-white [&:hover_svg]:text-black"
          style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}
          data-clickable
        >
          <GoogleLogo />
          Sign in with Google
        </a>
      </motion.div>

      <motion.div
        className="absolute bottom-8 left-1/2 -translate-x-1/2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5 }}
      >
        <motion.div
          className="text-foreground/70"
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
        >
          <ChevronDown className="w-8 h-8" strokeWidth={2} />
        </motion.div>
      </motion.div>
    </section>
  );
}
