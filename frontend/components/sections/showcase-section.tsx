"use client";

import { motion } from "framer-motion";

const cards = [
  {
    image: "/identity.png",
    title: "Human Identity",
    text: "In an age where AI can scrape, profile, and synthesize personal data from any document it touches, Velum ensures that what makes you you — your name, your history, your details — stays illegible to the machines mining it. Your identity remains visible to the people who matter, and noise to everyone else.",
  },
  {
    image: "/art.png",
    title: "Artwork",
    text: "Artists spend lifetimes developing a voice, only to have it extracted, replicated, and fed into generative models with a single PDF upload. Velum embeds an invisible barrier between your work and the algorithms that would learn from it without your consent.",
  },
  {
    image: "/law.png",
    title: "Personal Documents",
    text: "Contracts, medical records, and legal filings are documents that carry the full weight of a life. They are increasingly parsed, stored, and analyzed by AI systems their owners never agreed to. Velum lets you share what needs to be shared with human eyes, while ensuring the machines in the middle read nothing of value.",
  },
];

export function ShowcaseSection() {
  return (
    <section id="showcase" className="bg-background px-6 py-24">
      <div className="max-w-6xl mx-auto">
        <motion.p
          className="text-muted-foreground text-sm uppercase tracking-widest mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          Showcase
        </motion.p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {cards.map((card, i) => (
            <motion.div
              key={i}
              className="bg-secondary rounded-xl overflow-hidden flex flex-col"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              whileHover={{ scale: 0.98 }}
            >
              <div className="aspect-video bg-muted">
                <img
                  src={card.image}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="p-8">
                <h3 className="font-serif text-xl text-foreground">
                  {card.title}
                </h3>
                <p className="text-muted-foreground text-sm mt-3">
                  {card.text}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
