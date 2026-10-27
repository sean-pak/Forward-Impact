import { Brand } from "./ui";

/** Light frame for pages a CBO sees: a top bar with Sam's name, then a centered column. */
export function PublicFrame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="public">
      <div className="public-bar">
        <div className={`public-bar-inner${wide ? " wide" : ""}`}><Brand /></div>
      </div>
      <main className={`public-main${wide ? " wide" : ""}`}>{children}</main>
    </div>
  );
}
