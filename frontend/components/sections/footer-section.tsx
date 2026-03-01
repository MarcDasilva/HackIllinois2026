"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

/** Matte gold - matches hero wordmark */
const VELUM_GOLD = "#b8a060";

export function FooterSection() {
  const [email, setEmail] = useState("");

  return (
    <footer className="relative bg-background px-6 py-24 overflow-hidden">
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-tr from-white/10 via-white/5 to-white/10 opacity-60 blur-3xl rounded-full" />
      </div>

      <div className="relative max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-end">
          <div>
            <motion.h2
              className="text-6xl md:text-8xl font-serif font-bold tracking-tight"
              style={{ color: VELUM_GOLD }}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              Velum
            </motion.h2>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <p className="text-muted-foreground text-sm mb-4">
              Get product updates and document security news.
            </p>
            <form
              onSubmit={(e) => e.preventDefault()}
              className="flex gap-2"
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                className="flex-1 bg-secondary border-0 rounded-lg px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                type="submit"
                className="bg-foreground text-background p-3 rounded-lg hover:bg-foreground/90 transition-colors"
                data-clickable
              >
                <ArrowRight className="w-5 h-5" />
              </button>
            </form>
          </motion.div>
        </div>

        <div className="mt-16 pt-8 border-t border-border flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-muted-foreground text-sm">
            © 2025 Velum. All rights reserved.
          </p>
          <div className="flex gap-6">
            <a
              href="#"
              className="text-muted-foreground hover:text-foreground text-sm"
              data-clickable
            >
              Privacy
            </a>
            <a
              href="#"
              className="text-muted-foreground hover:text-foreground text-sm"
              data-clickable
            >
              Terms
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
