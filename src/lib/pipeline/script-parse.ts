import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { resolveAIProvider } from "@/lib/ai/provider-factory";
import type { ModelConfigPayload } from "@/lib/ai/provider-factory";
import { SCRIPT_PARSE_SYSTEM, buildScriptParsePrompt } from "@/lib/ai/prompts/script-parse";
import { eq } from "drizzle-orm";
import type { Task } from "@/lib/task-queue";

export async function handleScriptParse(task: Task) {
  const payload = task.payload as { projectId: string; modelConfig?: ModelConfigPayload };
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, payload.projectId));

  if (!project || !project.script) {
    throw new Error("Project or script not found");
  }

  const ai = resolveAIProvider(payload.modelConfig);
  const result = await ai.generateText(buildScriptParsePrompt(project.script), {
    systemPrompt: SCRIPT_PARSE_SYSTEM,
    temperature: 0.7,
  });

  const screenplay = JSON.parse(result);

  await db
    .update(projects)
    .set({ updatedAt: new Date() })
    .where(eq(projects.id, payload.projectId));

  // Auto-enqueue character extraction now that screenplay is parsed
  const { enqueueTask } = await import("@/lib/task-queue");
  await enqueueTask({
    type: "character_extract",
    projectId: payload.projectId,
    payload: {
      projectId: payload.projectId,
      screenplay: result,
      modelConfig: payload.modelConfig,
    },
  });

  return screenplay;
}
