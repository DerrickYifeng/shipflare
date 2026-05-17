"use client";

interface SkillStartData {
  skillName: string;
  model: string | null;
  context: string;
  parentRunId: string | null;
}

interface SkillFinishData {
  skillName: string;
  status: "ok" | "error";
  error?: string;
}

type SkillStartPart = {
  type: "data-skill-start";
  data: SkillStartData;
};

type SkillFinishPart = {
  type: "data-skill-finish";
  data: SkillFinishData;
};

type SkillPartInput = SkillStartPart | SkillFinishPart;

export function SkillPart({ part }: { part: SkillPartInput }) {
  if (part.type === "data-skill-start") {
    return (
      <div
        data-testid="skill-part"
        className="text-xs italic text-muted-foreground"
      >
        Running skill <code>{part.data.skillName}</code>…
      </div>
    );
  }

  const { skillName, status, error } = part.data;
  return (
    <div
      data-testid="skill-part"
      className={`text-xs italic ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      Skill <code>{skillName}</code>{" "}
      {status === "ok" ? "finished" : `failed: ${error}`}
    </div>
  );
}
