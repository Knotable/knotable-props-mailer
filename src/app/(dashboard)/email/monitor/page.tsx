import { MonitorClient } from "./monitor-client";

type Props = {
  searchParams: Promise<{ emailId?: string; auto?: string }>;
};

export default async function MonitorPage({ searchParams }: Props) {
  const { emailId, auto } = await searchParams;
  return <MonitorClient emailId={emailId} autoStart={auto === "1"} />;
}
