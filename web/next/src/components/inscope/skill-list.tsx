import { StatusBadge } from "@/components/inscope/status-badge"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { InscopeWorkspace } from "@/lib/inscope"

// What `inscope skill list` prints for one workspace: the skills inscope links here, then anything else in the folder with whose it is. A source or a link's target is a long path or URL, so it wraps anywhere and is never clamped.
export function SkillList({ skills }: { skills: InscopeWorkspace["skills"] }) {
  return (
    <div className="space-y-3">
      <ItemGroup>
        {skills.own.map((skill) => (
          <Item key={skill.name} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>
                <span className="font-mono">{skill.name}</span>
                {skill.linked ? (
                  <StatusBadge tone="ok">Linked</StatusBadge>
                ) : (
                  <StatusBadge tone="warn">Missing</StatusBadge>
                )}
              </ItemTitle>
              <ItemDescription className="line-clamp-none font-mono wrap-anywhere">
                {skill.source ?? "bundled self-skill"}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      {skills.other.length > 0 && (
        <>
          <p className="text-muted-foreground text-sm">
            Also in this folder, not added by inscope here:
          </p>
          <ItemGroup>
            {skills.other.map((skill) => (
              <Item key={skill.name} variant="muted" size="sm">
                <ItemContent>
                  <ItemTitle>
                    <span className="font-mono">{skill.name}</span>
                    {skill.kind === "stale" && <StatusBadge tone="warn">Stale</StatusBadge>}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none wrap-anywhere">
                    {skill.label}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </>
      )}
    </div>
  )
}
