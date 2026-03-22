import { NextResponse } from "next/server";
import { streamText } from "ai";
import { createLanguageModel, extractJSON } from "@/lib/ai/ai-sdk";
import type { ProviderConfig } from "@/lib/ai/ai-sdk";
import { db } from "@/lib/db";
import { projects, characters, shots, dialogues, storyboardVersions } from "@/lib/db/schema";
import { eq, asc, and, lt, gt, desc } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import path from "path";
import { ulid } from "ulid";
import { enqueueTask } from "@/lib/task-queue";
import type { TaskType } from "@/lib/task-queue";
import {
  SCRIPT_PARSE_SYSTEM,
  buildScriptParsePrompt,
} from "@/lib/ai/prompts/script-parse";
import {
  SCRIPT_GENERATE_SYSTEM,
  buildScriptGeneratePrompt,
} from "@/lib/ai/prompts/script-generate";
import {
  CHARACTER_EXTRACT_SYSTEM,
  buildCharacterExtractPrompt,
} from "@/lib/ai/prompts/character-extract";
import {
  buildShotSplitPrompt,
  buildShotSplitSystem,
} from "@/lib/ai/prompts/shot-split";
import { getModelMaxDuration } from "@/lib/ai/model-limits";
import {
  buildFirstFramePrompt,
  buildLastFramePrompt,
} from "@/lib/ai/prompts/frame-generate";
import { buildSceneFramePrompt } from "@/lib/ai/prompts/scene-frame-generate";
import { resolveImageProvider, resolveVideoProvider, resolveAIProvider } from "@/lib/ai/provider-factory";
import { buildVideoPrompt, buildReferenceVideoPrompt } from "@/lib/ai/prompts/video-generate";
import { REF_VIDEO_PROMPT_SYSTEM, buildRefVideoPromptRequest } from "@/lib/ai/prompts/ref-video-prompt-generate";
import { buildCharacterTurnaroundPrompt } from "@/lib/ai/prompts/character-image";
import { assembleVideo } from "@/lib/video/ffmpeg";

export const maxDuration = 300;

/** Map user-facing ratio string to ImageOptions fields */
function ratioToImageOpts(ratio?: string): { aspectRatio?: string; size?: string } {
  switch (ratio) {
    case "16:9":  return { aspectRatio: "16:9", size: "2560x1440" };
    case "9:16":  return { aspectRatio: "9:16", size: "1440x2560" };
    case "1:1":   return { aspectRatio: "1:1",  size: "2048x2048" };
    default:      return { aspectRatio: "16:9", size: "2560x1440" };
  }
}

/**
 * Check if a character is visible on-screen by looking for their name
 * in the videoScript or startFrameDesc fields.
 */
function isCharacterOnScreen(
  characterName: string,
  videoScript: string,
  startFrameDesc: string | null | undefined
): boolean {
  const text = `${videoScript} ${startFrameDesc ?? ""}`;
  return text.includes(characterName);
}


async function getVersionedUploadDir(versionId: string | null | undefined): Promise<string> {
  if (!versionId) return process.env.UPLOAD_DIR || "./uploads";
  const [version] = await db
    .select({ label: storyboardVersions.label, projectId: storyboardVersions.projectId })
    .from(storyboardVersions)
    .where(eq(storyboardVersions.id, versionId));
  if (!version) return process.env.UPLOAD_DIR || "./uploads";
  return path.join(process.env.UPLOAD_DIR || "./uploads", "projects", version.projectId, version.label);
}

function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Try to parse JSON error bodies (e.g. Google GenAI ApiError)
  try {
    const parsed = JSON.parse(err.message) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {}
  return err.message;
}

interface ModelConfig {
  text?: ProviderConfig | null;
  image?: ProviderConfig | null;
  video?: ProviderConfig | null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  // Verify project ownership
  const [ownerCheck] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!ownerCheck) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json()) as {
    action: string;
    payload?: Record<string, unknown>;
    modelConfig?: ModelConfig;
  };

  const { action, payload, modelConfig } = body;

  if (action === "script_generate") {
    return handleScriptGenerate(projectId, payload, modelConfig);
  }

  if (action === "script_parse") {
    return handleScriptParseStream(projectId, modelConfig);
  }

  if (action === "character_extract") {
    return handleCharacterExtract(projectId, modelConfig);
  }

  if (action === "single_character_image") {
    return handleSingleCharacterImage(payload, modelConfig);
  }

  if (action === "batch_character_image") {
    return handleBatchCharacterImage(projectId, modelConfig);
  }

  if (action === "shot_split") {
    return handleShotSplitStream(projectId, modelConfig);
  }

  if (action === "single_shot_rewrite") {
    return handleSingleShotRewrite(projectId, payload, modelConfig);
  }

  if (action === "batch_frame_generate") {
    return handleBatchFrameGenerate(projectId, payload, modelConfig);
  }

  if (action === "single_frame_generate") {
    return handleSingleFrameGenerate(projectId, payload, modelConfig);
  }

  if (action === "single_video_generate") {
    return handleSingleVideoGenerate(payload, modelConfig);
  }

  if (action === "batch_video_generate") {
    return handleBatchVideoGenerate(projectId, payload, modelConfig);
  }

  if (action === "single_scene_frame") {
    return handleSingleSceneFrame(projectId, payload, modelConfig);
  }

  if (action === "batch_scene_frame") {
    return handleBatchSceneFrame(projectId, payload, modelConfig);
  }

  if (action === "single_reference_video") {
    return handleSingleReferenceVideo(projectId, payload, modelConfig);
  }

  if (action === "batch_reference_video") {
    return handleBatchReferenceVideo(projectId, payload, modelConfig);
  }

  if (action === "single_video_prompt") {
    return handleSingleVideoPrompt(projectId, payload, modelConfig);
  }

  if (action === "batch_video_prompt") {
    return handleBatchVideoPrompt(projectId, payload, modelConfig);
  }

  if (action === "video_assemble") {
    return handleVideoAssembleSync(projectId, payload);
  }

  // Image/video generation - keep in task queue
  const task = await enqueueTask({
    type: action as NonNullable<TaskType>,
    projectId,
    payload: { projectId, ...payload, modelConfig },
  });

  return NextResponse.json(task, { status: 201 });
}

// --- script_generate: stream plain text screenplay from an idea ---

async function handleScriptGenerate(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const idea = (payload?.idea as string) || "";
  if (!idea.trim()) {
    return NextResponse.json({ error: "No idea provided" }, { status: 400 });
  }

  if (!modelConfig?.text) {
    return NextResponse.json(
      { error: "No text model configured" },
      { status: 400 }
    );
  }

  // Save the original idea before generating
  await db
    .update(projects)
    .set({ idea, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  const model = createLanguageModel(modelConfig.text);

  const result = streamText({
    model,
    system: SCRIPT_GENERATE_SYSTEM,
    prompt: buildScriptGeneratePrompt(idea),
    temperature: 0.8,
    onFinish: async ({ text }) => {
      try {
        await db
          .update(projects)
          .set({ script: text, updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        console.log(`[ScriptGenerate] Saved generated script for ${projectId}`);
      } catch (err) {
        console.error("[ScriptGenerate] onFinish error:", err);
      }
    },
  });

  return result.toTextStreamResponse();
}

// --- script_parse: parse user script into structured screenplay ---

async function handleScriptParseStream(
  projectId: string,
  modelConfig?: ModelConfig
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project?.script) {
    return NextResponse.json(
      { error: "Project or script not found" },
      { status: 404 }
    );
  }

  if (!modelConfig?.text) {
    return NextResponse.json(
      { error: "No text model configured" },
      { status: 400 }
    );
  }

  const model = createLanguageModel(modelConfig.text);

  const result = streamText({
    model,
    system: SCRIPT_PARSE_SYSTEM,
    prompt: buildScriptParsePrompt(project.script),
    temperature: 0.7,
    onFinish: async ({ text }) => {
      try {
        const screenplay = extractJSON(text);
        JSON.parse(screenplay); // validate JSON
        await db
          .update(projects)
          .set({ updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        console.log(`[ScriptParse] Parsed screenplay for ${projectId}`);
      } catch (err) {
        console.error("[ScriptParse] onFinish error:", err);
      }
    },
  });

  return result.toTextStreamResponse();
}

// --- character_extract: stream character extraction from script ---

async function handleCharacterExtract(
  projectId: string,
  modelConfig?: ModelConfig
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project?.script) {
    return NextResponse.json(
      { error: "Project or script not found" },
      { status: 404 }
    );
  }

  if (!modelConfig?.text) {
    return NextResponse.json(
      { error: "No text model configured" },
      { status: 400 }
    );
  }

  // Delete existing characters for re-extraction
  await db.delete(characters).where(eq(characters.projectId, projectId));

  const model = createLanguageModel(modelConfig.text);

  const result = streamText({
    model,
    system: CHARACTER_EXTRACT_SYSTEM,
    prompt: buildCharacterExtractPrompt(project.script),
    temperature: 0.5,
    onFinish: async ({ text }) => {
      try {
        const extracted = JSON.parse(extractJSON(text)) as Array<{
          name: string;
          description: string;
          visualHint?: string;
        }>;

        for (const char of extracted) {
          await db.insert(characters).values({
            id: ulid(),
            projectId,
            name: char.name,
            description: char.description,
            visualHint: char.visualHint ?? "",
          });
        }

        console.log(
          `[CharacterExtract] Extracted ${extracted.length} characters`
        );
      } catch (err) {
        console.error("[CharacterExtract] onFinish error:", err);
      }
    },
  });

  return result.toTextStreamResponse();
}

// --- single_character_image: generate turnaround image for one character ---

async function handleSingleCharacterImage(
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const characterId = payload?.characterId as string;
  if (!characterId) {
    return NextResponse.json({ error: "No characterId provided" }, { status: 400 });
  }

  if (!modelConfig?.image) {
    return NextResponse.json({ error: "No image model configured" }, { status: 400 });
  }

  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId));

  if (!character) {
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  }

  const ai = resolveImageProvider(modelConfig);
  const prompt = buildCharacterTurnaroundPrompt(character.description || character.name, character.name);

  try {
    const imagePath = await ai.generateImage(prompt, {
      size: "2560x1440",
      aspectRatio: "16:9",
      quality: "hd",
    });
    await db
      .update(characters)
      .set({ referenceImage: imagePath })
      .where(eq(characters.id, characterId));
    return NextResponse.json({ characterId, imagePath, status: "ok" });
  } catch (err) {
    console.error(`[SingleCharacterImage] Error for ${character.name}:`, err);
    return NextResponse.json({ characterId, status: "error", error: extractErrorMessage(err) }, { status: 500 });
  }
}

// --- batch_character_image: generate turnaround images for all characters ---

async function handleBatchCharacterImage(
  projectId: string,
  modelConfig?: ModelConfig
) {
  if (!modelConfig?.image) {
    return NextResponse.json(
      { error: "No image model configured" },
      { status: 400 }
    );
  }

  const allCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));

  const needImages = allCharacters.filter((c) => !c.referenceImage);
  if (needImages.length === 0) {
    return NextResponse.json({ results: [], message: "All characters already have images" });
  }

  const ai = resolveImageProvider(modelConfig);

  const results = await Promise.all(
    needImages.map(async (character) => {
      try {
        const prompt = buildCharacterTurnaroundPrompt(character.description || character.name, character.name);
        const imagePath = await ai.generateImage(prompt, {
          size: "2560x1440",
          aspectRatio: "16:9",
          quality: "hd",
        });
        await db
          .update(characters)
          .set({ referenceImage: imagePath })
          .where(eq(characters.id, character.id));
        return { characterId: character.id, name: character.name, imagePath, status: "ok" };
      } catch (err) {
        console.error(`[BatchCharacterImage] Error for ${character.name}:`, err);
        return { characterId: character.id, name: character.name, status: "error", error: extractErrorMessage(err) };
      }
    })
  );

  return NextResponse.json({ results });
}

// --- shot_split: stream shot splitting ---

async function handleShotSplitStream(
  projectId: string,
  modelConfig?: ModelConfig
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project) {
    return NextResponse.json(
      { error: "Project not found" },
      { status: 404 }
    );
  }

  if (!modelConfig?.text) {
    return NextResponse.json(
      { error: "No text model configured" },
      { status: 400 }
    );
  }

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));

  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const characterVisualHints = projectCharacters
    .filter((c) => c.visualHint)
    .map((c) => ({ name: c.name, visualHint: c.visualHint! }));

  const model = createLanguageModel(modelConfig.text);

  const videoMaxDuration = getModelMaxDuration(modelConfig?.video?.modelId);
  const shotSplitPrompt = buildShotSplitPrompt(project.script || "", characterDescriptions, characterVisualHints);
  console.log("[ShotSplit] characterVisualHints:", JSON.stringify(characterVisualHints));
  console.log("[ShotSplit] prompt:\n" + shotSplitPrompt);
  const result = streamText({
    model,
    system: buildShotSplitSystem(videoMaxDuration),
    prompt: shotSplitPrompt,
    temperature: 0.5,
    onFinish: async ({ text }) => {
      try {
        const parsedShots = JSON.parse(extractJSON(text)) as Array<{
          sequence: number;
          sceneDescription: string;
          startFrame: string;
          endFrame: string;
          motionScript: string;
          videoScript?: string;
          duration: number;
          dialogues: Array<{ character: string; text: string }>;
          cameraDirection?: string;
        }>;

        // Create a new version record
        const [maxVersionRow] = await db
          .select({ maxNum: storyboardVersions.versionNum })
          .from(storyboardVersions)
          .where(eq(storyboardVersions.projectId, projectId))
          .orderBy(desc(storyboardVersions.versionNum))
          .limit(1);
        const nextVersionNum = (maxVersionRow?.maxNum ?? 0) + 1;
        const today = new Date();
        const dateStr = today.getUTCFullYear().toString() +
          String(today.getUTCMonth() + 1).padStart(2, "0") +
          String(today.getUTCDate()).padStart(2, "0");
        const versionLabel = `${dateStr}-V${nextVersionNum}`;
        const versionId = ulid();
        await db.insert(storyboardVersions).values({
          id: versionId,
          projectId,
          label: versionLabel,
          versionNum: nextVersionNum,
          createdAt: new Date(),
        });

        for (const shot of parsedShots) {
          const shotId = ulid();
          await db.insert(shots).values({
            id: shotId,
            projectId,
            versionId,
            sequence: shot.sequence,
            prompt: shot.sceneDescription,
            startFrameDesc: shot.startFrame,
            endFrameDesc: shot.endFrame,
            motionScript: shot.motionScript,
            videoScript: shot.videoScript ?? null,
            cameraDirection: shot.cameraDirection || "static",
            duration: shot.duration,
          });

          for (let i = 0; i < (shot.dialogues || []).length; i++) {
            const dialogue = shot.dialogues[i];
            const matchedChar = projectCharacters.find(
              (c) => c.name === dialogue.character
            );
            if (matchedChar) {
              await db.insert(dialogues).values({
                id: ulid(),
                shotId,
                characterId: matchedChar.id,
                text: dialogue.text,
                sequence: i,
              });
            }
          }
        }

        console.log(
          `[ShotSplit] Created ${parsedShots.length} shots`
        );
      } catch (err) {
        console.error("[ShotSplit] onFinish error:", err);
      }
    },
  });

  return result.toTextStreamResponse();
}

// --- single_shot_rewrite: regenerate text fields for one shot ---

async function handleSingleShotRewrite(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const shotId = payload?.shotId as string;
  if (!shotId) {
    return NextResponse.json({ error: "No shotId provided" }, { status: 400 });
  }
  if (!modelConfig?.text) {
    return NextResponse.json({ error: "No text model configured" }, { status: 400 });
  }

  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));
  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");
  const characterVisualHints = projectCharacters
    .filter((c) => c.visualHint)
    .map((c) => `${c.name}：${c.visualHint}`)
    .join("\n");

  const model = createLanguageModel(modelConfig.text);

  const prompt = `You are a storyboard director. Rewrite the text fields for a single shot so the descriptions are vivid, safe for AI image generation, and free of any potentially sensitive content.

Current shot (sequence ${shot.sequence}):
- Scene description: ${shot.prompt || ""}
- Start frame: ${shot.startFrameDesc || ""}
- End frame: ${shot.endFrameDesc || ""}
- Motion script: ${shot.motionScript || ""}
- Video script: ${shot.videoScript || ""}
- Camera direction: ${shot.cameraDirection || "static"}
- Duration: ${shot.duration}s

Character references:
${characterDescriptions || "none"}
${characterVisualHints ? `\nCHARACTER VISUAL IDs (MANDATORY — whenever a character appears in any field, write their name followed by exactly this identifier in parentheses, e.g. 天枢真君（银发金瞳）. Never invent alternatives):\n${characterVisualHints}` : ""}

Return ONLY a JSON object (no markdown fences) with these fields:
{
  "prompt": "rewritten scene description",
  "startFrameDesc": "rewritten start frame description",
  "endFrameDesc": "rewritten end frame description",
  "motionScript": "rewritten motion script in time-segmented format (0-Xs: ... Xs-Ys: ...)",
  "videoScript": "rewritten concise video model prompt: 1-2 sentences, no timestamps, just core motion and camera arc",
  "cameraDirection": "camera direction (keep original or adjust)"
}

IMPORTANT: Keep the same scene, characters, and narrative intent. Only rephrase to avoid safety filter triggers. Match the language of the original text.`;

  console.log(`[SingleShotRewrite] Shot ${shot.sequence} prompt:\n${prompt}`);

  try {
    const { text } = await import("ai").then(({ generateText }) =>
      generateText({ model, prompt, temperature: 0.7 })
    );

    const parsed = JSON.parse(extractJSON(text)) as {
      prompt: string;
      startFrameDesc: string;
      endFrameDesc: string;
      motionScript: string;
      videoScript?: string;
      cameraDirection: string;
    };

    await db
      .update(shots)
      .set({
        prompt: parsed.prompt,
        startFrameDesc: parsed.startFrameDesc,
        endFrameDesc: parsed.endFrameDesc,
        motionScript: parsed.motionScript,
        videoScript: parsed.videoScript ?? null,
        cameraDirection: parsed.cameraDirection,
      })
      .where(eq(shots.id, shotId));

    return NextResponse.json({ shotId, status: "ok", ...parsed });
  } catch (err) {
    console.error(`[SingleShotRewrite] Error for shot ${shotId}:`, err);
    return NextResponse.json({ shotId, status: "error", error: extractErrorMessage(err) }, { status: 500 });
  }
}

// --- batch_frame_generate: sequential frame generation with continuity chain ---

async function handleBatchFrameGenerate(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  if (!modelConfig?.image) {
    return NextResponse.json(
      { error: "No image model configured" },
      { status: 400 }
    );
  }

  const batchVersionId = payload?.versionId as string | undefined;
  const imageOpts = ratioToImageOpts(payload?.ratio as string | undefined);
  const allShots = await db
    .select()
    .from(shots)
    .where(batchVersionId
      ? and(eq(shots.projectId, projectId), eq(shots.versionId, batchVersionId))
      : eq(shots.projectId, projectId))
    .orderBy(asc(shots.sequence));

  if (allShots.length === 0) {
    return NextResponse.json({ results: [], message: "No shots found" });
  }

  const versionedUploadDir = batchVersionId
    ? await getVersionedUploadDir(batchVersionId)
    : process.env.UPLOAD_DIR || "./uploads";

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));

  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const ai = resolveImageProvider(modelConfig, versionedUploadDir);
  const results: Array<{ shotId: string; sequence: number; status: string; firstFrame?: string; lastFrame?: string; error?: string }> = [];

  const overwrite = payload?.overwrite === true;
  let previousLastFrame: string | undefined;

  for (let i = 0; i < allShots.length; i++) {
    const shot = allShots[i];

    // Skip completed shots in normal mode, but advance the chain from their existing lastFrame
    if (!overwrite && shot.firstFrame && shot.lastFrame) {
      previousLastFrame = shot.lastFrame;
      results.push({
        shotId: shot.id,
        sequence: shot.sequence,
        status: "skipped",
      });
      continue;
    }

    try {
      await db
        .update(shots)
        .set({ status: "generating" })
        .where(eq(shots.id, shot.id));

      let firstFramePath: string;

      const charRefImages = projectCharacters.map((c) => c.referenceImage).filter(Boolean) as string[];

      if (i === 0) {
        // First shot: generate first frame
        const firstPrompt = buildFirstFramePrompt({
          sceneDescription: shot.prompt || "",
          startFrameDesc: shot.startFrameDesc || shot.prompt || "",
          characterDescriptions,
        });
        firstFramePath = await ai.generateImage(firstPrompt, {
          ...imageOpts,
          quality: "hd",
          referenceImages: charRefImages,
        });
      } else {
        // Continuity chain: reuse previous shot's last frame
        firstFramePath = previousLastFrame!;
      }

      // Generate last frame for this shot
      const lastPrompt = buildLastFramePrompt({
        sceneDescription: shot.prompt || "",
        endFrameDesc: shot.endFrameDesc || shot.prompt || "",
        characterDescriptions,
        firstFramePath,
      });
      const lastFramePath = await ai.generateImage(lastPrompt, {
        ...imageOpts,
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
        .where(eq(shots.id, shot.id));

      previousLastFrame = lastFramePath;

      results.push({
        shotId: shot.id,
        sequence: shot.sequence,
        status: "ok",
        firstFrame: firstFramePath,
        lastFrame: lastFramePath,
      });

      console.log(`[BatchFrameGenerate] Shot ${shot.sequence} completed`);
    } catch (err) {
      console.error(`[BatchFrameGenerate] Error for shot ${shot.sequence}:`, err);
      await db
        .update(shots)
        .set({ status: "failed" })
        .where(eq(shots.id, shot.id));
      results.push({
        shotId: shot.id,
        sequence: shot.sequence,
        status: "error",
        error: extractErrorMessage(err),
      });
    }
  }

  return NextResponse.json({ results });
}

// --- single_frame_generate: synchronous frame generation for one shot ---

async function handleSingleFrameGenerate(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const shotId = payload?.shotId as string;
  if (!shotId) {
    return NextResponse.json({ error: "No shotId provided" }, { status: 400 });
  }
  if (!modelConfig?.image) {
    return NextResponse.json({ error: "No image model configured" }, { status: 400 });
  }

  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }

  const versionedUploadDir = await getVersionedUploadDir(shot.versionId);

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));

  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const charRefImages = projectCharacters
    .map((c) => c.referenceImage)
    .filter(Boolean) as string[];

  // Find previous shot's last frame for continuity — same version only (if shot has a version)
  const [previousShot] = shot.versionId
    ? await db
        .select()
        .from(shots)
        .where(and(
          eq(shots.projectId, projectId),
          eq(shots.versionId, shot.versionId),
          lt(shots.sequence, shot.sequence)
        ))
        .orderBy(desc(shots.sequence))
        .limit(1)
    : await db
        .select()
        .from(shots)
        .where(and(
          eq(shots.projectId, projectId),
          lt(shots.sequence, shot.sequence)
        ))
        .orderBy(desc(shots.sequence))
        .limit(1);

  const [nextShot] = shot.versionId
    ? await db
        .select()
        .from(shots)
        .where(and(
          eq(shots.projectId, projectId),
          eq(shots.versionId, shot.versionId),
          gt(shots.sequence, shot.sequence)
        ))
        .orderBy(asc(shots.sequence))
        .limit(1)
    : await db
        .select()
        .from(shots)
        .where(and(
          eq(shots.projectId, projectId),
          gt(shots.sequence, shot.sequence)
        ))
        .orderBy(asc(shots.sequence))
        .limit(1);

  const ai = resolveImageProvider(modelConfig, versionedUploadDir);
  const imageOpts = ratioToImageOpts(payload?.ratio as string | undefined);

  try {
    await db.update(shots).set({ status: "generating" }).where(eq(shots.id, shotId));

    // Reuse previous shot's lastFrame directly — no need to regenerate
    let firstFramePath: string;
    if (previousShot?.lastFrame) {
      firstFramePath = previousShot.lastFrame;
    } else {
      const firstPrompt = buildFirstFramePrompt({
        sceneDescription: shot.prompt || "",
        startFrameDesc: shot.startFrameDesc || shot.prompt || "",
        characterDescriptions,
      });
      firstFramePath = await ai.generateImage(firstPrompt, {
        ...imageOpts,
        quality: "hd",
        referenceImages: charRefImages,
      });
    }

    const lastPrompt = buildLastFramePrompt({
      sceneDescription: shot.prompt || "",
      endFrameDesc: shot.endFrameDesc || shot.prompt || "",
      characterDescriptions,
      firstFramePath,
    });
    const lastFramePath = await ai.generateImage(lastPrompt, {
      ...imageOpts,
      quality: "hd",
      referenceImages: [firstFramePath, ...charRefImages],
    });

    await db
      .update(shots)
      .set({ firstFrame: firstFramePath, lastFrame: lastFramePath, status: "completed" })
      .where(eq(shots.id, shotId));

    // Sync next shot's firstFrame to maintain continuity chain
    if (nextShot) {
      await db
        .update(shots)
        .set({ firstFrame: lastFramePath })
        .where(eq(shots.id, nextShot.id));
    }

    return NextResponse.json({ shotId, firstFrame: firstFramePath, lastFrame: lastFramePath, status: "ok" });
  } catch (err) {
    console.error(`[SingleFrameGenerate] Error for shot ${shotId}:`, err);
    await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shotId));
    return NextResponse.json({ shotId, status: "error", error: extractErrorMessage(err) }, { status: 500 });
  }
}

// --- single_video_generate: synchronous video generation for one shot ---

async function handleSingleVideoGenerate(
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const shotId = payload?.shotId as string;
  if (!shotId) {
    return NextResponse.json({ error: "No shotId provided" }, { status: 400 });
  }
  if (!modelConfig?.video) {
    return NextResponse.json({ error: "No video model configured" }, { status: 400 });
  }

  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }
  if (!shot.firstFrame || !shot.lastFrame) {
    return NextResponse.json({ error: "Shot frames not generated yet" }, { status: 400 });
  }

  const versionedUploadDir = await getVersionedUploadDir(shot.versionId);

  const shotCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, shot.projectId));
  const characterDescriptions = shotCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const shotDialogues = await db
    .select({ text: dialogues.text, characterId: dialogues.characterId, sequence: dialogues.sequence })
    .from(dialogues)
    .where(eq(dialogues.shotId, shotId))
    .orderBy(asc(dialogues.sequence));

  const videoProvider = resolveVideoProvider(modelConfig, versionedUploadDir);

  try {
    await db.update(shots).set({ status: "generating" }).where(eq(shots.id, shotId));

    const ratio = (payload?.ratio as string) || "16:9";

    const videoModelId = modelConfig?.video?.modelId;
    const videoMaxDuration = getModelMaxDuration(videoModelId);
    const effectiveDuration = Math.min(shot.duration ?? 10, videoMaxDuration);

    const videoScript = shot.videoScript || shot.motionScript || shot.prompt || "";
    const videoContextForDialogue = videoScript;
    const onScreenDialogueChars = shotDialogues
      .map((d) => shotCharacters.find((c) => c.id === d.characterId)?.name ?? "Unknown")
      .filter((name) => isCharacterOnScreen(name, videoContextForDialogue, shot.startFrameDesc));
    
    const dialogueList = shotDialogues.map((d) => {
      const char = shotCharacters.find((c) => c.id === d.characterId);
      const characterName = char?.name ?? "Unknown";
      const onScreen = isCharacterOnScreen(characterName, videoContextForDialogue, shot.startFrameDesc);
      const visualHint = onScreen ? (char?.visualHint || undefined) : undefined;
      return {
        characterName,
        text: d.text,
        offscreen: !onScreen,
        visualHint,
      };
    });
    const videoPrompt = shot.videoPrompt || buildVideoPrompt({
      videoScript,
      cameraDirection: shot.cameraDirection || "static",
      startFrameDesc: shot.startFrameDesc ?? undefined,
      endFrameDesc: shot.endFrameDesc ?? undefined,
      duration: effectiveDuration,
      characters: shotCharacters,
      dialogues: dialogueList.length > 0 ? dialogueList : undefined,
    });

    const result = await videoProvider.generateVideo({
      firstFrame: shot.firstFrame,
      lastFrame: shot.lastFrame,
      prompt: videoPrompt,
      duration: effectiveDuration,
      ratio,
    });

    await db
      .update(shots)
      .set({ videoUrl: result.filePath, status: "completed" })
      .where(eq(shots.id, shotId));

    return NextResponse.json({ shotId, videoUrl: result.filePath, status: "ok" });
  } catch (err) {
    console.error(`[SingleVideoGenerate] Error for shot ${shotId}:`, err);
    await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shotId));
    return NextResponse.json({ shotId, status: "error", error: extractErrorMessage(err) }, { status: 500 });
  }
}

// --- batch_video_generate: sequential video generation for all eligible shots ---

async function handleBatchVideoGenerate(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  if (!modelConfig?.video) {
    return NextResponse.json({ error: "No video model configured" }, { status: 400 });
  }

  const batchVersionId = payload?.versionId as string | undefined;
  const allShots = await db
    .select()
    .from(shots)
    .where(batchVersionId
      ? and(eq(shots.projectId, projectId), eq(shots.versionId, batchVersionId))
      : eq(shots.projectId, projectId))
    .orderBy(asc(shots.sequence));

  const versionedUploadDir = batchVersionId
    ? await getVersionedUploadDir(batchVersionId)
    : process.env.UPLOAD_DIR || "./uploads";

  const overwrite = payload?.overwrite === true;
  const eligible = allShots.filter((s) =>
    s.firstFrame && s.lastFrame && (overwrite || !s.videoUrl)
  );
  if (eligible.length === 0) {
    return NextResponse.json({ results: [], message: "No eligible shots" });
  }

  const batchCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));
  const characterDescriptions = batchCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const videoProvider = resolveVideoProvider(modelConfig, versionedUploadDir);
  const ratio = (payload?.ratio as string) || "16:9";
  const videoMaxDuration = getModelMaxDuration(modelConfig?.video?.modelId);

  // Mark all as generating
  await Promise.all(
    eligible.map((shot) =>
      db.update(shots).set({ status: "generating" }).where(eq(shots.id, shot.id))
    )
  );

  const results = await Promise.all(
    eligible.map(async (shot): Promise<{ shotId: string; sequence: number; status: "ok" | "error"; videoUrl?: string; error?: string }> => {
      try {
        const effectiveDuration = Math.min(shot.duration ?? 10, videoMaxDuration);
        const shotDialogues = await db
          .select({ text: dialogues.text, characterId: dialogues.characterId, sequence: dialogues.sequence })
          .from(dialogues)
          .where(eq(dialogues.shotId, shot.id))
          .orderBy(asc(dialogues.sequence));

        const videoScript = shot.videoScript || shot.motionScript || shot.prompt || "";
        const videoContextForDialogue = videoScript;
        const onScreenDialogueChars = shotDialogues
          .map((d) => batchCharacters.find((c) => c.id === d.characterId)?.name ?? "Unknown")
          .filter((name) => isCharacterOnScreen(name, videoContextForDialogue, shot.startFrameDesc));
        
        const dialogueList = shotDialogues.map((d) => {
          const char = batchCharacters.find((c) => c.id === d.characterId);
          const characterName = char?.name ?? "Unknown";
          const onScreen = isCharacterOnScreen(characterName, videoContextForDialogue, shot.startFrameDesc);
          const visualHint = onScreen ? (char?.visualHint || undefined) : undefined;
          return {
            characterName,
            text: d.text,
            offscreen: !onScreen,
            visualHint,
          };
        });

        const videoPrompt = shot.videoPrompt || buildVideoPrompt({
          videoScript,
          cameraDirection: shot.cameraDirection || "static",
          startFrameDesc: shot.startFrameDesc ?? undefined,
          endFrameDesc: shot.endFrameDesc ?? undefined,
          duration: effectiveDuration,
          characters: batchCharacters,
          dialogues: dialogueList.length > 0 ? dialogueList : undefined,
        });

        const result = await videoProvider.generateVideo({
          firstFrame: shot.firstFrame!,
          lastFrame: shot.lastFrame!,
          prompt: videoPrompt,
          duration: effectiveDuration,
          ratio,
        });

        await db
          .update(shots)
          .set({ videoUrl: result.filePath, status: "completed" })
          .where(eq(shots.id, shot.id));

        console.log(`[BatchVideoGenerate] Shot ${shot.sequence} completed`);
        return { shotId: shot.id, sequence: shot.sequence, status: "ok", videoUrl: result.filePath };
      } catch (err) {
        console.error(`[BatchVideoGenerate] Error for shot ${shot.sequence}:`, err);
        await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shot.id));
        return { shotId: shot.id, sequence: shot.sequence, status: "error", error: extractErrorMessage(err) };
      }
    })
  );

  return NextResponse.json({ results });
}

// --- single_scene_frame: generate Toonflow-style scene reference frame only ---

async function handleSingleSceneFrame(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const shotId = payload?.shotId as string | undefined;
  if (!shotId) {
    return NextResponse.json({ error: "No shotId provided" }, { status: 400 });
  }
  if (!modelConfig?.image) {
    return NextResponse.json({ error: "No image model configured" }, { status: 400 });
  }

  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }

  const versionedUploadDir = await getVersionedUploadDir(shot.versionId);

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, shot.projectId));

  const charRefs = projectCharacters
    .filter((c) => !!c.referenceImage)
    .map((c) => ({ name: c.name, imagePath: c.referenceImage as string }));

  if (charRefs.length === 0) {
    return NextResponse.json(
      { error: "No character reference images available. Please generate character reference images first." },
      { status: 400 }
    );
  }

  const charRefMapping = charRefs.map((c, i) => `${c.name}=图片${i + 1}`).join("，");
  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  try {
    await db.update(shots).set({ status: "generating" }).where(eq(shots.id, shotId));

    const imageProvider = resolveImageProvider(modelConfig, versionedUploadDir);
    const sceneFramePrompt = buildSceneFramePrompt({
      sceneDescription: shot.prompt || "",
      charRefMapping,
      characterDescriptions,
      cameraDirection: shot.cameraDirection,
      startFrameDesc: shot.startFrameDesc,
      motionScript: shot.motionScript,
    });

    console.log(`[SingleSceneFrame] Shot ${shot.sequence}: generating scene frame, mapping="${charRefMapping}"`);

    const sceneFramePath = await imageProvider.generateImage(sceneFramePrompt, {
      quality: "hd",
      referenceImages: charRefs.map((c) => c.imagePath),
    });

    await db
      .update(shots)
      .set({ sceneRefFrame: sceneFramePath, status: "pending" })
      .where(eq(shots.id, shotId));

    return NextResponse.json({ shotId, sceneRefFrame: sceneFramePath, status: "ok" });
  } catch (err) {
    console.error(`[SingleSceneFrame] Error for shot ${shot.sequence}:`, err);
    await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shotId));
    return NextResponse.json(
      { shotId, status: "error", error: extractErrorMessage(err) },
      { status: 500 }
    );
  }
}

// --- batch_scene_frame: generate scene reference frames for all eligible shots ---

async function handleBatchSceneFrame(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  if (!modelConfig?.image) {
    return NextResponse.json({ error: "No image model configured" }, { status: 400 });
  }

  const overwrite = payload?.overwrite === true;
  const batchVersionId = payload?.versionId as string | undefined;

  const allShots = await db
    .select()
    .from(shots)
    .where(batchVersionId
      ? and(eq(shots.projectId, projectId), eq(shots.versionId, batchVersionId))
      : eq(shots.projectId, projectId))
    .orderBy(asc(shots.sequence));

  const versionedUploadDir = batchVersionId
    ? await getVersionedUploadDir(batchVersionId)
    : process.env.UPLOAD_DIR || "./uploads";

  const eligible = allShots.filter(
    (s) => s.status !== "generating" && (overwrite || !s.sceneRefFrame)
  );
  if (eligible.length === 0) {
    return NextResponse.json({ results: [], message: "No eligible shots" });
  }

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));

  const charRefs = projectCharacters
    .filter((c) => !!c.referenceImage)
    .map((c) => ({ name: c.name, imagePath: c.referenceImage as string }));

  if (charRefs.length === 0) {
    return NextResponse.json(
      { error: "No character reference images available." },
      { status: 400 }
    );
  }

  const charRefMapping = charRefs.map((c, i) => `${c.name}=图片${i + 1}`).join("，");
  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const imageProvider = resolveImageProvider(modelConfig, versionedUploadDir);

  await Promise.all(
    eligible.map((shot) =>
      db.update(shots).set({ status: "generating" }).where(eq(shots.id, shot.id))
    )
  );

  const results: Array<{
    shotId: string;
    sequence: number;
    status: "ok" | "error";
    sceneRefFrame?: string;
    error?: string;
  }> = [];

  for (const shot of eligible) {
    try {
      const sceneFramePrompt = buildSceneFramePrompt({
        sceneDescription: shot.prompt || "",
        charRefMapping,
        characterDescriptions,
        cameraDirection: shot.cameraDirection,
        startFrameDesc: shot.startFrameDesc,
        motionScript: shot.motionScript,
      });

      console.log(`[BatchSceneFrame] Shot ${shot.sequence}: generating scene frame, mapping="${charRefMapping}"`);

      const sceneFramePath = await imageProvider.generateImage(sceneFramePrompt, {
        quality: "hd",
        referenceImages: charRefs.map((c) => c.imagePath),
      });

      await db
        .update(shots)
        .set({ sceneRefFrame: sceneFramePath, status: "pending" })
        .where(eq(shots.id, shot.id));

      results.push({ shotId: shot.id, sequence: shot.sequence, status: "ok", sceneRefFrame: sceneFramePath });
    } catch (err) {
      console.error(`[BatchSceneFrame] Error for shot ${shot.sequence}:`, err);
      await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shot.id));
      results.push({ shotId: shot.id, sequence: shot.sequence, status: "error", error: extractErrorMessage(err) });
    }
  }

  return NextResponse.json({ results });
}

// --- single_reference_video: text2video with character reference images ---

async function handleSingleReferenceVideo(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const shotId = payload?.shotId as string | undefined;
  if (!shotId) {
    return NextResponse.json({ error: "No shotId provided" }, { status: 400 });
  }
  if (!modelConfig?.video) {
    return NextResponse.json({ error: "No video model configured" }, { status: 400 });
  }
  if (!modelConfig?.image) {
    return NextResponse.json({ error: "No image model configured" }, { status: 400 });
  }

  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
  if (!shot) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }

  const versionedUploadDir = await getVersionedUploadDir(shot.versionId);

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, shot.projectId));

  // Toonflow pattern: collect all character reference images
  const charRefs = projectCharacters
    .filter((c) => !!c.referenceImage)
    .map((c) => ({ name: c.name, imagePath: c.referenceImage as string }));

  if (charRefs.length === 0) {
    return NextResponse.json(
      { error: "No character reference images available. Please generate character reference images first." },
      { status: 400 }
    );
  }

  // Build Toonflow name→image mapping: "角色A=图片1，角色B=图片2"
  const charRefMapping = charRefs.map((c, i) => `${c.name}=图片${i + 1}`).join("，");

  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const shotDialogues = await db
    .select({ text: dialogues.text, characterId: dialogues.characterId, sequence: dialogues.sequence })
    .from(dialogues)
    .where(eq(dialogues.shotId, shotId))
    .orderBy(asc(dialogues.sequence));
  const videoContextForDialogue = shot.motionScript || shot.videoScript || shot.prompt || "";
  const onScreenDialogueChars = shotDialogues
    .map((d) => projectCharacters.find((c) => c.id === d.characterId)?.name ?? "Unknown")
    .filter((name) => isCharacterOnScreen(name, videoContextForDialogue, shot.startFrameDesc));
  
  const dialogueList = shotDialogues.map((d) => {
    const char = projectCharacters.find((c) => c.id === d.characterId);
    const characterName = char?.name ?? "Unknown";
    const onScreen = isCharacterOnScreen(characterName, videoContextForDialogue, shot.startFrameDesc);
    const visualHint = onScreen ? (char?.visualHint || undefined) : undefined;
    return {
      characterName,
      text: d.text,
      offscreen: !onScreen,
      visualHint,
    };
  });

  const ratio = (payload?.ratio as string) || "16:9";

  try {
    await db.update(shots).set({ status: "generating" }).where(eq(shots.id, shotId));

    // Step 1: Reuse existing scene ref frame, or generate a new one (Toonflow-style)
    let sceneFramePath = shot.sceneRefFrame ?? null;
    if (!sceneFramePath) {
      const imageProvider = resolveImageProvider(modelConfig, versionedUploadDir);
      const sceneFramePrompt = buildSceneFramePrompt({
        sceneDescription: shot.prompt || "",
        charRefMapping,
        characterDescriptions,
        cameraDirection: shot.cameraDirection,
        startFrameDesc: shot.startFrameDesc,
        motionScript: shot.motionScript,
      });
      console.log(`[SingleReferenceVideo] Shot ${shot.sequence}: generating scene frame, mapping="${charRefMapping}"`);
      sceneFramePath = await imageProvider.generateImage(sceneFramePrompt, {
        quality: "hd",
        referenceImages: charRefs.map((c) => c.imagePath),
      });
      await db.update(shots).set({ sceneRefFrame: sceneFramePath }).where(eq(shots.id, shotId));
    } else {
      console.log(`[SingleReferenceVideo] Shot ${shot.sequence}: reusing existing scene frame`);
    }

    // Step 2: Generate video using scene frame as initial image
    const videoProvider = resolveVideoProvider(modelConfig, versionedUploadDir);

    const videoModelId = modelConfig?.video?.modelId;
    const videoMaxDuration = getModelMaxDuration(videoModelId);
    const effectiveDuration = Math.min(shot.duration ?? 10, videoMaxDuration);

    // Step 2b: Use stored videoPrompt if available; otherwise generate from scene frame via vision AI
    let videoPrompt: string;
    if (shot.videoPrompt) {
      videoPrompt = shot.videoPrompt;
    } else {
      const textProvider = resolveAIProvider(modelConfig);
      try {
        const motionContext = shot.motionScript || shot.videoScript || shot.prompt || "";
        const promptRequest = buildRefVideoPromptRequest({
          motionScript: motionContext,
          cameraDirection: shot.cameraDirection || "static",
          duration: effectiveDuration,
          characters: projectCharacters,
          dialogues: dialogueList.length > 0 ? dialogueList : undefined,
        });
        console.log(`[SingleReferenceVideo] Shot ${shot.sequence} promptRequest:\n${promptRequest}`);
        const rawPrompt = await textProvider.generateText(promptRequest, {
          systemPrompt: REF_VIDEO_PROMPT_SYSTEM,
          images: [sceneFramePath],
          temperature: 0.7,
        });
        videoPrompt = `Duration: ${effectiveDuration}s.\n\n${rawPrompt.trim()}`;
      } catch (err) {
        console.warn("[SingleReferenceVideo] Vision prompt generation failed, falling back:", err);
        videoPrompt = buildReferenceVideoPrompt({
          videoScript: shot.videoScript || shot.motionScript || shot.prompt || "",
          cameraDirection: shot.cameraDirection || "static",
          duration: effectiveDuration,
          characters: projectCharacters,
          dialogues: dialogueList.length > 0 ? dialogueList : undefined,
        });
      }
    }

    console.log(`[SingleReferenceVideo] Shot ${shot.sequence}: generating video from scene frame`);

    const result = await videoProvider.generateVideo({
      initialImage: sceneFramePath,
      prompt: videoPrompt,
      duration: effectiveDuration,
      ratio,
    });

    await db
      .update(shots)
      .set({
        referenceVideoUrl: result.filePath,
        lastFrameUrl: result.lastFrameUrl ?? null,
        status: "completed",
      })
      .where(eq(shots.id, shotId));

    return NextResponse.json({ shotId, referenceVideoUrl: result.filePath, status: "ok" });
  } catch (err) {
    console.error(`[SingleReferenceVideo] Error for shot ${shot.sequence}:`, err);
    await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shotId));
    return NextResponse.json(
      { shotId, status: "error", error: extractErrorMessage(err) },
      { status: 500 }
    );
  }
}

// --- batch_reference_video: sequential text2video for all eligible shots ---

async function handleBatchReferenceVideo(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  if (!modelConfig?.video) {
    return NextResponse.json({ error: "No video model configured" }, { status: 400 });
  }
  if (!modelConfig?.image) {
    return NextResponse.json({ error: "No image model configured" }, { status: 400 });
  }

  const batchVersionId = payload?.versionId as string | undefined;
  const allShots = await db
    .select()
    .from(shots)
    .where(batchVersionId
      ? and(eq(shots.projectId, projectId), eq(shots.versionId, batchVersionId))
      : eq(shots.projectId, projectId))
    .orderBy(asc(shots.sequence));

  const versionedUploadDir = batchVersionId
    ? await getVersionedUploadDir(batchVersionId)
    : process.env.UPLOAD_DIR || "./uploads";

  const overwrite = payload?.overwrite === true;
  const eligible = allShots.filter(
    (s) => s.status !== "generating" && (overwrite || !s.referenceVideoUrl)
  );
  if (eligible.length === 0) {
    return NextResponse.json({ results: [], message: "No eligible shots" });
  }

  const projectCharacters = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId));

  // Toonflow pattern: collect all character reference images
  const charRefs = projectCharacters
    .filter((c) => !!c.referenceImage)
    .map((c) => ({ name: c.name, imagePath: c.referenceImage as string }));

  if (charRefs.length === 0) {
    return NextResponse.json(
      { error: "No character reference images available." },
      { status: 400 }
    );
  }

  // Build Toonflow name→image mapping (same for all shots — characters are consistent)
  const charRefMapping = charRefs.map((c, i) => `${c.name}=图片${i + 1}`).join("，");

  const characterDescriptions = projectCharacters
    .map((c) => `${c.name}: ${c.description}`)
    .join("\n");

  const imageProvider = resolveImageProvider(modelConfig, versionedUploadDir);
  const videoProvider = resolveVideoProvider(modelConfig, versionedUploadDir);
  const textProvider = resolveAIProvider(modelConfig);
  const ratio = (payload?.ratio as string) || "16:9";
  const videoMaxDuration = getModelMaxDuration(modelConfig?.video?.modelId);

  await Promise.all(
    eligible.map((shot) =>
      db.update(shots).set({ status: "generating" }).where(eq(shots.id, shot.id))
    )
  );

  const results = await Promise.all(
    eligible.map(async (shot): Promise<{ shotId: string; sequence: number; status: "ok" | "error"; referenceVideoUrl?: string; error?: string }> => {
      try {
        const effectiveDuration = Math.min(shot.duration ?? 10, videoMaxDuration);
        const shotDialogues = await db
          .select({ text: dialogues.text, characterId: dialogues.characterId, sequence: dialogues.sequence })
          .from(dialogues)
          .where(eq(dialogues.shotId, shot.id))
          .orderBy(asc(dialogues.sequence));
        const videoContextForDialogue = shot.motionScript || shot.videoScript || shot.prompt || "";
        const onScreenDialogueChars = shotDialogues
          .map((d) => projectCharacters.find((c) => c.id === d.characterId)?.name ?? "Unknown")
          .filter((name) => isCharacterOnScreen(name, videoContextForDialogue, shot.startFrameDesc));
        
        const dialogueList = shotDialogues.map((d) => {
          const char = projectCharacters.find((c) => c.id === d.characterId);
          const characterName = char?.name ?? "Unknown";
          const onScreen = isCharacterOnScreen(characterName, videoContextForDialogue, shot.startFrameDesc);
          const visualHint = onScreen ? (char?.visualHint || undefined) : undefined;
          return {
            characterName,
            text: d.text,
            offscreen: !onScreen,
            visualHint,
          };
        });

        // Step 1: Generate scene reference frame (Toonflow-style)
        const sceneFramePrompt = buildSceneFramePrompt({
          sceneDescription: shot.prompt || "",
          charRefMapping,
          characterDescriptions,
          cameraDirection: shot.cameraDirection,
          startFrameDesc: shot.startFrameDesc,
          motionScript: shot.motionScript,
        });

        console.log(`[BatchReferenceVideo] Shot ${shot.sequence}: generating scene frame, mapping="${charRefMapping}"`);

        const sceneFramePath = await imageProvider.generateImage(sceneFramePrompt, {
          quality: "hd",
          referenceImages: charRefs.map((c) => c.imagePath),
        });

        // Save scene frame for display (separate field — does not pollute firstFrame used by keyframe mode)
        await db.update(shots).set({ sceneRefFrame: sceneFramePath }).where(eq(shots.id, shot.id));

        // Step 2: Use stored videoPrompt if available; otherwise generate from scene frame via vision AI
        let videoPrompt: string;
        if (shot.videoPrompt) {
          videoPrompt = shot.videoPrompt;
        } else {
          try {
            const motionContext = shot.motionScript || shot.videoScript || shot.prompt || "";
            const promptRequest = buildRefVideoPromptRequest({
              motionScript: motionContext,
              cameraDirection: shot.cameraDirection || "static",
              duration: effectiveDuration,
              characters: projectCharacters,
              dialogues: dialogueList.length > 0 ? dialogueList : undefined,
            });
            const rawPrompt = await textProvider.generateText(promptRequest, {
              systemPrompt: REF_VIDEO_PROMPT_SYSTEM,
              images: [sceneFramePath],
              temperature: 0.7,
            });
            videoPrompt = `Duration: ${effectiveDuration}s.\n\n${rawPrompt.trim()}`;
          } catch (err) {
            console.warn("[BatchReferenceVideo] Vision prompt generation failed, falling back:", err);
            videoPrompt = buildReferenceVideoPrompt({
              videoScript: shot.videoScript || shot.motionScript || shot.prompt || "",
              cameraDirection: shot.cameraDirection || "static",
              duration: effectiveDuration,
              characters: projectCharacters,
              dialogues: dialogueList.length > 0 ? dialogueList : undefined,
            });
          }
        }

        console.log(`[BatchReferenceVideo] Shot ${shot.sequence}: generating video from scene frame`);

        const result = await videoProvider.generateVideo({
          initialImage: sceneFramePath,
          prompt: videoPrompt,
          duration: effectiveDuration,
          ratio,
        });

        await db
          .update(shots)
          .set({
            referenceVideoUrl: result.filePath,
            lastFrameUrl: result.lastFrameUrl ?? null,
            status: "completed",
          })
          .where(eq(shots.id, shot.id));

        console.log(`[BatchReferenceVideo] Shot ${shot.sequence} completed`);
        return { shotId: shot.id, sequence: shot.sequence, status: "ok", referenceVideoUrl: result.filePath };
      } catch (err) {
        console.error(`[BatchReferenceVideo] Error for shot ${shot.sequence}:`, err);
        await db.update(shots).set({ status: "failed" }).where(eq(shots.id, shot.id));
        return {
          shotId: shot.id,
          sequence: shot.sequence,
          status: "error",
          error: extractErrorMessage(err),
        };
      }
    })
  );

  return NextResponse.json({ results });
}

// --- video_assemble: synchronous ffmpeg concat + subtitle burn ---

async function handleVideoAssembleSync(projectId: string, payload?: Record<string, unknown>) {
  const [project] = await db.select({ generationMode: projects.generationMode }).from(projects).where(eq(projects.id, projectId));

  let versionId = payload?.versionId as string | undefined;

  // If no versionId provided, fall back to the latest version for this project
  if (!versionId) {
    const [latestVersion] = await db
      .select({ id: storyboardVersions.id })
      .from(storyboardVersions)
      .where(eq(storyboardVersions.projectId, projectId))
      .orderBy(desc(storyboardVersions.versionNum))
      .limit(1);
    versionId = latestVersion?.id;
  }

  const projectShots = await db
    .select()
    .from(shots)
    .where(versionId
      ? and(eq(shots.projectId, projectId), eq(shots.versionId, versionId))
      : eq(shots.projectId, projectId))
    .orderBy(asc(shots.sequence));

  const isReference = project?.generationMode === "reference";
  const videoPaths = projectShots
    .map((s) => isReference ? s.referenceVideoUrl : s.videoUrl)
    .filter(Boolean) as string[];

  if (videoPaths.length === 0) {
    return NextResponse.json({ error: "No video clips to assemble" }, { status: 400 });
  }

  // Get dialogues for subtitles
  const allDialogues = [];
  for (const shot of projectShots) {
    const shotDialogues = await db
      .select({
        text: dialogues.text,
        characterName: characters.name,
        sequence: dialogues.sequence,
        shotSequence: shots.sequence,
      })
      .from(dialogues)
      .innerJoin(characters, eq(dialogues.characterId, characters.id))
      .innerJoin(shots, eq(dialogues.shotId, shots.id))
      .where(eq(dialogues.shotId, shot.id))
      .orderBy(asc(dialogues.sequence));
    allDialogues.push(...shotDialogues);
  }

  try {
    const outputPath = await assembleVideo({
      videoPaths,
      subtitles: allDialogues.map((d) => ({
        text: `${d.characterName}: ${d.text}`,
        shotSequence: d.shotSequence,
      })),
      projectId,
      shotDurations: projectShots.map((s) => s.duration ?? 10),
    });

    await db
      .update(projects)
      .set({ status: "completed", finalVideoUrl: outputPath, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    console.log(`[VideoAssemble] Completed: ${outputPath}`);
    return NextResponse.json({ outputPath, status: "ok" });
  } catch (err) {
    console.error("[VideoAssemble] Error:", err);
    return NextResponse.json({ status: "error", error: extractErrorMessage(err) }, { status: 500 });
  }
}

// ─── Generate Video Prompt (single) ──────────────────────────────────────────

async function handleSingleVideoPrompt(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const shotId = payload?.shotId as string;
  console.log(`[SingleVideoPrompt] called, shotId=${shotId}`);
  if (!shotId) return NextResponse.json({ error: "shotId required" }, { status: 400 });

  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId)).limit(1);
  if (!shot) return NextResponse.json({ error: "Shot not found" }, { status: 404 });

  // Use sceneRefFrame for reference mode, or first/last frame for keyframe mode
  const frameForVision = shot.sceneRefFrame || shot.firstFrame || shot.lastFrame;
  console.log(`[SingleVideoPrompt] shot.sequence=${shot.sequence}, sceneRefFrame=${!!shot.sceneRefFrame}, firstFrame=${!!shot.firstFrame}, frameForVision=${!!frameForVision}`);
  if (!frameForVision) {
    return NextResponse.json({ error: "No frame available. Generate frames first." }, { status: 400 });
  }

  const shotCharacters = await db.select().from(characters).where(eq(characters.projectId, shot.projectId));
  const shotDialogues = await db
    .select({ text: dialogues.text, characterId: dialogues.characterId, sequence: dialogues.sequence })
    .from(dialogues)
    .where(eq(dialogues.shotId, shotId))
    .orderBy(asc(dialogues.sequence));
  const videoContextForDialogue = shot.videoScript || shot.motionScript || shot.prompt || "";
  const onScreenDialogueChars = shotDialogues
    .map((d) => shotCharacters.find((c) => c.id === d.characterId)?.name ?? "Unknown")
    .filter((name) => isCharacterOnScreen(name, videoContextForDialogue, shot.startFrameDesc));
  
  const dialogueList = shotDialogues.map((d) => {
    const char = shotCharacters.find((c) => c.id === d.characterId);
    const characterName = char?.name ?? "Unknown";
    const onScreen = isCharacterOnScreen(characterName, videoContextForDialogue, shot.startFrameDesc);
    const visualHint = onScreen ? (char?.visualHint || undefined) : undefined;
    return {
      characterName,
      text: d.text,
      offscreen: !onScreen,
      visualHint,
    };
  });

  try {
    const videoModelId = modelConfig?.video?.modelId;
    const videoMaxDuration = getModelMaxDuration(videoModelId);
    const effectiveDuration = Math.min(shot.duration ?? 10, videoMaxDuration);
    const textProvider = resolveAIProvider(modelConfig);
    const motionContext = shot.motionScript || shot.videoScript || shot.prompt || "";
    const promptRequest = buildRefVideoPromptRequest({
      motionScript: motionContext,
      cameraDirection: shot.cameraDirection || "static",
      duration: effectiveDuration,
      characters: shotCharacters,
      dialogues: dialogueList.length > 0 ? dialogueList : undefined,
    });
    console.log(`[SingleVideoPrompt] Shot ${shot.sequence} promptRequest:\n${promptRequest}`);
    const rawPrompt = await textProvider.generateText(promptRequest, {
      systemPrompt: REF_VIDEO_PROMPT_SYSTEM,
      images: [frameForVision],
      temperature: 0.7,
    });
    const videoPrompt = `Duration: ${effectiveDuration}s.\n\n${rawPrompt.trim()}`;
    console.log(`[SingleVideoPrompt] Shot ${shot.sequence} videoPrompt:\n${videoPrompt}`);
    await db.update(shots).set({ videoPrompt }).where(eq(shots.id, shotId));
    return NextResponse.json({ shotId, videoPrompt, status: "ok" });
  } catch (err) {
    console.error("[SingleVideoPrompt] Error:", err);
    return NextResponse.json({ status: "error", error: extractErrorMessage(err) }, { status: 500 });
  }
}

// ─── Generate Video Prompt (batch) ───────────────────────────────────────────

async function handleBatchVideoPrompt(
  projectId: string,
  payload?: Record<string, unknown>,
  modelConfig?: ModelConfig
) {
  const batchVersionId = payload?.versionId as string | undefined;

  const batchShots = batchVersionId
    ? await db.select().from(shots).where(and(eq(shots.projectId, projectId), eq(shots.versionId, batchVersionId))).orderBy(asc(shots.sequence))
    : await db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.sequence));

  const batchCharacters = await db.select().from(characters).where(eq(characters.projectId, projectId));

  // Only process shots that have at least one frame
  const eligible = batchShots.filter((s) => s.sceneRefFrame || s.firstFrame || s.lastFrame);

  const textProvider = resolveAIProvider(modelConfig);
  const results: Array<{ shotId: string; status: string }> = [];
  const videoMaxDuration = getModelMaxDuration(modelConfig?.video?.modelId);

  for (const shot of eligible) {
    try {
      const effectiveDuration = Math.min(shot.duration ?? 10, videoMaxDuration);
      const frameForVision = shot.sceneRefFrame || shot.firstFrame || shot.lastFrame;
      const shotDialogues = await db
        .select({ text: dialogues.text, characterId: dialogues.characterId, sequence: dialogues.sequence })
        .from(dialogues)
        .where(eq(dialogues.shotId, shot.id))
        .orderBy(asc(dialogues.sequence));
      const videoContextForDialogue = shot.videoScript || shot.motionScript || shot.prompt || "";
      const onScreenDialogueChars = shotDialogues
        .map((d) => batchCharacters.find((c) => c.id === d.characterId)?.name ?? "Unknown")
        .filter((name) => isCharacterOnScreen(name, videoContextForDialogue, shot.startFrameDesc));
      
      const dialogueList = shotDialogues.map((d) => {
        const char = batchCharacters.find((c) => c.id === d.characterId);
        const characterName = char?.name ?? "Unknown";
        const onScreen = isCharacterOnScreen(characterName, videoContextForDialogue, shot.startFrameDesc);
        const visualHint = onScreen ? (char?.visualHint || undefined) : undefined;
        return {
          characterName,
          text: d.text,
          offscreen: !onScreen,
          visualHint,
        };
      });

      const motionContext = shot.videoScript || shot.motionScript || shot.prompt || "";
      const promptRequest = buildRefVideoPromptRequest({
        motionScript: motionContext,
        cameraDirection: shot.cameraDirection || "static",
        duration: effectiveDuration,
        characters: batchCharacters,
        dialogues: dialogueList.length > 0 ? dialogueList : undefined,
      });
      const rawPrompt = await textProvider.generateText(promptRequest, {
        systemPrompt: REF_VIDEO_PROMPT_SYSTEM,
        images: [frameForVision!],
        temperature: 0.7,
      });
      const videoPrompt = `Duration: ${effectiveDuration}s.\n\n${rawPrompt.trim()}`;
      await db.update(shots).set({ videoPrompt }).where(eq(shots.id, shot.id));
      results.push({ shotId: shot.id, status: "ok" });
    } catch (err) {
      console.error(`[BatchVideoPrompt] Shot ${shot.sequence} failed:`, err);
      results.push({ shotId: shot.id, status: "error" });
    }
  }

  return NextResponse.json({ results, status: "ok" });
}
