import ResearchWebGraph from '@/components/ResearchWebGraph';

const seedPmid = process.env.NEXT_PUBLIC_SEED_PMID || '41817805';

export default function Home() {
  return <ResearchWebGraph seedPmid={seedPmid} />;
}
