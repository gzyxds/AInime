type CharacterRef = { name: string; visualHint?: string | null };

function buildCharacterLine(characters?: CharacterRef[]): string | null {
  const withHints = (characters ?? []).filter((c) => c.visualHint);
  if (!withHints.length) return null;
  return withHints.map((c) => `${c.name}（${c.visualHint}）`).join("，");
}

/**
 * Prompt for reference-image-based video generation (Toonflow/Kling reference mode).
 * Seedance-style format: Shot description (prose) → Camera → 【对白口型】.
 * No frame interpolation header, no [FRAME ANCHORS] — the reference image provides visual context.
 */
export function buildReferenceVideoPrompt(params: {
  videoScript: string;
  cameraDirection: string;
  duration?: number;
  characters?: CharacterRef[];
  dialogues?: Array<{ characterName: string; text: string; offscreen?: boolean; visualHint?: string }>;
}): string {
  const lines: string[] = [];

  if (params.duration) {
    lines.push(`Duration: ${params.duration}s.`);
    lines.push(``);
  }

  const charLine = buildCharacterLine(params.characters);
  if (charLine) {
    lines.push(`角色形象：${charLine}。`);
    lines.push(``);
  }

  lines.push(params.videoScript);

  lines.push(``);
  lines.push(`Camera: ${params.cameraDirection}.`);

  if (params.dialogues?.length) {
    lines.push(``);
    for (const d of params.dialogues) {
      if (d.offscreen) {
        lines.push(`【画外音】${d.characterName}: "${d.text}"`);
      } else {
        const label = d.visualHint ? `${d.characterName}（${d.visualHint}）` : d.characterName;
        lines.push(`【对白口型】${label}: "${d.text}"`);
      }
    }
  }

  return lines.join("\n");
}

export function buildVideoPrompt(params: {
  videoScript: string;
  cameraDirection: string;
  startFrameDesc?: string;
  endFrameDesc?: string;
  sceneDescription?: string;       // kept for call-site compatibility, not used in output
  duration?: number;
  characters?: CharacterRef[];
  dialogues?: Array<{ characterName: string; text: string; offscreen?: boolean; visualHint?: string }>;
}): string {
  const lines: string[] = [];

  if (params.duration) {
    lines.push(`Duration: ${params.duration}s.`);
    lines.push(``);
  }

  const charLine = buildCharacterLine(params.characters);
  if (charLine) {
    lines.push(`角色形象：${charLine}。`);
    lines.push(``);
  }

  lines.push(`Smoothly interpolate from the opening frame to the closing frame.`);
  lines.push(``);

  lines.push(params.videoScript);

  lines.push(``);
  lines.push(`Camera: ${params.cameraDirection}.`);

  const hasStart = !!params.startFrameDesc;
  const hasEnd = !!params.endFrameDesc;
  if (hasStart || hasEnd) {
    lines.push(``);
    lines.push(`[FRAME ANCHORS]`);
    if (hasStart) lines.push(`Opening frame: ${params.startFrameDesc}`);
    if (hasEnd) lines.push(`Closing frame: ${params.endFrameDesc}`);
  }

  if (params.dialogues?.length) {
    lines.push(``);
    for (const d of params.dialogues) {
      if (d.offscreen) {
        lines.push(`【画外音】${d.characterName}: "${d.text}"`);
      } else {
        const label = d.visualHint ? `${d.characterName}（${d.visualHint}）` : d.characterName;
        lines.push(`【对白口型】${label}: "${d.text}"`);
      }
    }
  }

  return lines.join("\n");
}
