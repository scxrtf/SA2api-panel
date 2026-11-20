import { enabled } from "@/lib/workspace/settings";
import { PanelConsole } from "./console";
import "@/vendor/lancer-light-ui/running-border.css";
import "@/features/agent-workspace/workspace.css";
import "./panel-shell.css";

export const dynamic = "force-dynamic";

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return <>
    <PanelConsole workspaceEnabled={enabled()} />
    {children}
  </>;
}
