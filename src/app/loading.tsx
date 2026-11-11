import { LoadingIndicator } from "./panel/components/ui";

export default function Loading() {
  return (
    <main className="route-loading" aria-busy="true">
      <LoadingIndicator label="正在加载面板…" />
    </main>
  );
}
