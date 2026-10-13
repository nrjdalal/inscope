import { FullDescription } from "@/components/inscope/full-description"
import { StatusBadge } from "@/components/inscope/status-badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import type { InscopeWorkspace } from "@/lib/inscope"

// What `inscope skill list` prints for one workspace: the skills inscope links here, then anything else in the folder with whose it is.
export function SkillList({ skills }: { skills: InscopeWorkspace["skills"] }) {
  if (!skills.own.length && !skills.other.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No skills</EmptyTitle>
          <EmptyDescription>
            inscope links none here, and the folder holds none of anyone else's.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
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
              <FullDescription className="font-mono">
                {skill.source ?? "bundled self-skill"}
              </FullDescription>
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
                  <FullDescription>{skill.label}</FullDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </>
      )}
    </div>
  )
}
