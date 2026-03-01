"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";

const plans = [
  {
    name: "Personal",
    price: "$15",
    period: "/month",
    description: "Encrypt and protect your sensitive documents",
    features: [
      "Up to 50 documents per month",
      "Blockchain verification",
      "Human-readable output",
      "Email support",
    ],
  },
  {
    name: "Professional",
    price: "$49",
    period: "/month",
    description: "For teams and heavier document workflows",
    features: [
      "Unlimited documents",
      "Organizational folders & security levels",
      "Priority support",
      "API access",
    ],
    popular: true,
  },
  {
    name: "Enterprise",
    price: null,
    period: "",
    description: "Custom volume, compliance, and dedicated support",
    features: [
      "Custom document limits",
      "SSO & audit logging",
      "Dedicated success manager",
      "SLA & compliance support",
    ],
    cta: "Contact us",
  },
];

export function PricingSection() {
  return (
    <section id="pricing" className="bg-secondary px-6 py-24">
      <div className="max-w-5xl mx-auto">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-5xl font-serif text-foreground">
            Simple, transparent pricing
          </h2>
          <p className="text-muted-foreground mt-4 max-w-md mx-auto">
            Protect your documents. Scale when you need to.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan, i) => (
            <motion.div
              key={i}
              className={`relative bg-background rounded-xl p-8 ticket-edge ${plan.popular ? "ring-2 ring-primary" : ""}`}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              data-clickable
            >
              {plan.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-white text-black text-xs font-medium px-3 py-1 rounded-full">
                  Popular
                </span>
              )}

              <div className="text-center pb-6 border-b border-dashed border-border">
                <h3 className="font-serif text-xl text-foreground">{plan.name}</h3>
                <div className="mt-4 flex items-baseline justify-center gap-1">
                  {plan.price ? (
                    <>
                      <span className="text-4xl md:text-5xl font-serif text-foreground">
                        {plan.price}
                      </span>
                      <span className="text-muted-foreground">{plan.period}</span>
                    </>
                  ) : (
                    <span className="text-2xl md:text-3xl font-serif text-muted-foreground">
                      Contact us
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-sm mt-2">
                  {plan.description}
                </p>
              </div>

              <ul className="mt-6 space-y-3">
                {plan.features.map((feature, j) => (
                  <li key={j} className="flex items-center gap-3 text-foreground">
                    <Check className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="text-sm">{feature}</span>
                  </li>
                ))}
              </ul>

              <button
                className={`w-full mt-8 py-3 px-6 rounded-lg font-medium transition-colors ${
                  plan.cta
                    ? "bg-secondary text-foreground hover:bg-accent/30 border border-border"
                    : plan.popular
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-secondary text-foreground hover:bg-accent/30"
                }`}
              >
                {plan.cta ?? "Get started"}
              </button>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
