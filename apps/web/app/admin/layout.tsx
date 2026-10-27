import { Brand } from "../components/ui";
import { Nav } from "./Nav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand href="/admin" />
        <Nav />
        <p className="nav-foot">Counts only confirmed data. Identifiers stay in the vault.</p>
      </aside>
      <div className="content">{children}</div>
    </div>
  );
}
