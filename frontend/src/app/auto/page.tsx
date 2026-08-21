import AutoPipeline from "@/components/AutoPipeline";

export default async function AutoPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const params = await searchParams;
  return <AutoPipeline initialUrl={params.url} />;
}
