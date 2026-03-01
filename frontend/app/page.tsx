import { LenisProvider } from "@/components/lenis-provider";
import { HeroSection } from "@/components/sections/hero-section";
import { ManifestoSection } from "@/components/sections/manifesto-section";
import { FeaturesSection } from "@/components/sections/features-section";
import { ShowcaseSection } from "@/components/sections/showcase-section";
import { PricingSection } from "@/components/sections/pricing-section";
import { FooterSection } from "@/components/sections/footer-section";

export default function Home() {
  return (
    <LenisProvider>
      <main className="bg-background">
        <HeroSection />
        <ManifestoSection />
        <FeaturesSection />
        <ShowcaseSection />
        <PricingSection />
        <FooterSection />
      </main>
    </LenisProvider>
  );
}
