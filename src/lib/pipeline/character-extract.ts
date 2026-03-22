import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { resolveAIProvider } from "@/lib/ai/provider-factory";
import type { ModelConfigPayload } from "@/lib/ai/provider-factory";
import {
  CHARACTER_EXTRACT_SYSTEM,
  buildCharacterExtractPrompt,
} from "@/lib/ai/prompts/character-extract";
import { ulid } from "ulid";
import type { Task } from "@/lib/task-queue";

export async function handleCharacterExtract(task: Task) {
  const payload = task.payload as { projectId: string; screenplay: string; modelConfig?: ModelConfigPayload };

  const ai = resolveAIProvider(payload.modelConfig);
  const result = await ai.generateText(
    buildCharacterExtractPrompt(payload.screenplay),
    { systemPrompt: CHARACTER_EXTRACT_SYSTEM, temperature: 0.5 }
  );

  const extracted = JSON.parse(result) as Array<{
    name: string;
    description: string;
    visualHint?: string;
  }>;

  const created = [];
  for (const char of extracted) {
    const id = ulid();
    const [record] = await db
      .insert(characters)
      .values({
        id,
        projectId: payload.projectId,
        name: char.name,
        description: char.description,
        visualHint: char.visualHint ?? "",
      })
      .returning();
    created.push(record);
  }

  return { characters: created };
}
