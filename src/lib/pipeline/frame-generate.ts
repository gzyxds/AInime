import { db } from "@/lib/db";
import { shots, characters } from "@/lib/db/schema";
import { resolveImageProvider } from "@/lib/ai/provider-factory";
import type { ModelConfigPayload } from "@/lib/ai/provider-factory";
import {
  buildFirstFramePrompt,
  buildLastFramePrompt,
} from "@/lib/ai/prompts/frame-generate";
import { eq, and, lt, desc } from "drizzle-orm";
import type { Task } from "@/lib/task-queue";

export async function handleFrameGenerate(task: Task) {
  const payload = task.payload as {
    shotId: string;
    projectId: string;
    modelConfig?: ModelConfigPayload;
  };

  const [shot] = await db
    .select()
    .from(shots)
    .where(eq(shots.id, payload.shotId));

  if (!shot) throw new Error("Shot not found");

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, payload.projectId));

  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const [previousShot] = await db
    .select()
    .from(shots)
    .where(
      and(
        eq(shots.projectId, payload.projectId),
        lt(shots.sequence, shot.sequence)
      )
    )
    .orderBy(desc(shots.sequence))
    .limit(1);

  const ai = resolveImageProvider(payload.modelConfig);

  await db
    .update(shots)
    .set({ status: "generating" })
    .where(eq(shots.id, payload.shotId));

  // Generate first frame using startFrameDesc
  const firstFramePrompt = buildFirstFramePrompt({
    sceneDescription: shot.prompt || "",
    startFrameDesc: shot.startFrameDesc || shot.prompt || "",
    characterDescriptions,
    previousLastFrame: previousShot?.lastFrame || undefined,
  });
  const firstFramePath = await ai.generateImage(firstFramePrompt, {
    quality: "hd",
    referenceImages: projectCharacters
      .map((c) => c.referenceImage)
      .filter(Boolean) as string[],
  });

  // Generate last frame using endFrameDesc
  const lastFramePrompt = buildLastFramePrompt({
    sceneDescription: shot.prompt || "",
    endFrameDesc: shot.endFrameDesc || shot.prompt || "",
    characterDescriptions,
    firstFramePath,
  });
  const charRefImages = projectCharacters
    .map((c) => c.referenceImage)
    .filter(Boolean) as string[];
  const lastFramePath = await ai.generateImage(lastFramePrompt, {
    quality: "hd",
    referenceImages: [firstFramePath, ...charRefImages],
  });

  await db
    .update(shots)
    .set({
      firstFrame: firstFramePath,
      lastFrame: lastFramePath,
      status: "completed",
    })
    .where(eq(shots.id, payload.shotId));

  return { firstFrame: firstFramePath, lastFrame: lastFramePath };
}
