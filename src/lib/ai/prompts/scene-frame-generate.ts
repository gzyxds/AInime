export function buildSceneFramePrompt(params: {
  sceneDescription: string;
  charRefMapping: string;
  characterDescriptions: string;
  cameraDirection?: string | null;
  startFrameDesc?: string | null;
  motionScript?: string | null;
}): string {
  const lines: string[] = [];

  lines.push(`Generate a single cinematic still image as a scene reference frame.`);
  lines.push(``);

  lines.push(`=== SCENE DESCRIPTION ===`);
  lines.push(params.sceneDescription);

  if (params.startFrameDesc) {
    lines.push(``);
    lines.push(`=== OPENING COMPOSITION ===`);
    lines.push(`The frame must depict this specific moment: ${params.startFrameDesc}`);
  }

  if (params.cameraDirection && params.cameraDirection !== "static") {
    lines.push(``);
    lines.push(`=== CAMERA FRAMING ===`);
    lines.push(`Camera direction: ${params.cameraDirection}`);
    lines.push(`Apply this exact camera angle/distance to the composition.`);
  }

  if (params.motionScript) {
    lines.push(``);
    lines.push(`=== ACTION / MOTION CONTEXT ===`);
    lines.push(`The characters are: ${params.motionScript}`);
    lines.push(`Capture the characters mid-action or at the key pose described.`);
  }

  lines.push(``);
  lines.push(`=== CHARACTER DESCRIPTIONS ===`);
  lines.push(params.characterDescriptions);

  lines.push(``);
  lines.push(`=== CHARACTER REFERENCE IMAGES ===`);
  lines.push(`Character reference images are attached. Correspondence: ${params.charRefMapping}`);
  lines.push(`You MUST reproduce each character EXACTLY as shown in their reference image — same face, clothing, hair, body type, and colors. Do NOT alter any character's appearance.`);

  lines.push(``);
  lines.push(`=== CRITICAL RULES ===`);
  lines.push(`1. Characters must match their reference images exactly`);
  lines.push(`2. The visual style is determined by the reference images — match it exactly`);
  lines.push(`3. Render the specific composition described above — do NOT default to a generic two-shot`);
  lines.push(`4. Fully rendered background — no blank or abstract backgrounds`);
  lines.push(`5. Cinematic framing with clear composition and depth`);

  return lines.join("\n");
}
