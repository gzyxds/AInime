// src/lib/ai/providers/veo.ts
import { GoogleGenAI } from "@google/genai";
import type { VideoProvider, VideoGenerateParams, VideoGenerateResult } from "../types";
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

const VALID_DURATIONS = [4, 6, 8] as const;

function clampDuration(duration: number): number {
  return VALID_DURATIONS.reduce((prev, curr) =>
    Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
  );
}

function toAspectRatio(ratio?: string): "16:9" | "9:16" {
  if (ratio === "9:16") return "9:16";
  return "16:9";
}

function readImageData(filePath: string): { imageBytes: string; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === ".png" ? "image/png" :
    ext === ".webp" ? "image/webp" :
    "image/jpeg";
  const imageBytes = fs.readFileSync(filePath, { encoding: "base64" });
  return { imageBytes, mimeType };
}

export class VeoProvider implements VideoProvider {
  private client: GoogleGenAI;
  private model: string;
  private uploadDir: string;

  constructor(params?: { apiKey?: string; baseUrl?: string; model?: string; uploadDir?: string }) {
    const options: ConstructorParameters<typeof GoogleGenAI>[0] = {
      apiKey: params?.apiKey || process.env.GEMINI_API_KEY || "",
    };
    if (params?.baseUrl) {
      const baseUrl = params.baseUrl.replace(/\/+$/, "").replace(/\/v\d[^/]*$/, "");
      options.httpOptions = { baseUrl };
    }
    this.client = new GoogleGenAI(options);
    this.model = params?.model || "veo-2.0-generate-001";
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    if (!("firstFrame" in params)) {
      throw new Error("Veo provider only supports keyframe (image2video) mode");
    }
    const durationSeconds = clampDuration(params.duration);
    const aspectRatio = toAspectRatio(params.ratio);
    const firstFrameData = readImageData(params.firstFrame!);
    const lastFrameData = readImageData(params.lastFrame!);

    console.log(
      `[Veo] Submitting task: model=${this.model}, duration=${durationSeconds}s, ratio=${aspectRatio}`
    );

    let operation = await this.client.models.generateVideos({
      model: this.model,
      prompt: params.prompt,
      image: firstFrameData,
      config: {
        lastFrame: lastFrameData,
        durationSeconds,
        aspectRatio,
      },
    });

    operation = await this.pollForResult(operation);

    const response = operation.response;

    if ((response?.raiMediaFilteredCount ?? 0) > 0) {
      throw new Error(
        `Veo generation blocked by safety filter: ${JSON.stringify(response?.raiMediaFilteredReasons)}`
      );
    }

    if (!response?.generatedVideos?.[0]) {
      throw new Error("No video returned from Veo");
    }
    const videoFile = response.generatedVideos[0].video;
    if (!videoFile) {
      throw new Error("No video URI returned from Veo");
    }

    const dir = path.join(this.uploadDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    const downloadPath = path.join(dir, `${ulid()}.mp4`);

    await this.client.files.download({ file: videoFile, downloadPath });

    console.log(`[Veo] Video saved to ${downloadPath}`);
    return { filePath: downloadPath };
  }

  private async pollForResult(
    initial: Awaited<ReturnType<GoogleGenAI["models"]["generateVideos"]>>
  ): Promise<typeof initial> {
    const maxAttempts = 60;
    let operation = initial;

    for (let i = 0; i < maxAttempts; i++) {
      console.log(`[Veo] Poll ${i + 1}: done=${operation.done}`);

      if (operation.done) {
        if (operation.error) {
          throw new Error(`Veo generation failed: ${JSON.stringify(operation.error)}`);
        }
        return operation;
      }

      await new Promise((resolve) => setTimeout(resolve, 10_000));
      operation = await this.client.operations.getVideosOperation({ operation });
    }

    throw new Error("Veo generation timed out after 10 minutes");
  }
}
