export function buildFirstFramePrompt(params: {
  sceneDescription: string;
  startFrameDesc: string;
  characterDescriptions: string;
  previousLastFrame?: string;
}): string {
  const lines: string[] = [];

  lines.push(`Create the OPENING FRAME of this shot as a single high-quality image.`);
  lines.push(``);
  lines.push(`=== CRITICAL: ART STYLE (HIGHEST PRIORITY) ===`);
  lines.push(`Read the CHARACTER DESCRIPTIONS and SCENE DESCRIPTION below. They specify or imply an art style.`);
  lines.push(`You MUST match that exact art style. Do NOT default to photorealism.`);
  lines.push(`- If descriptions mention 动漫/漫画/anime/manga/卡通/cartoon → produce anime/manga-style illustration`);
  lines.push(`- If descriptions mention 写实/真人/photorealistic → produce photorealistic image`);
  lines.push(`- If reference images are attached, their visual style is the ground truth — match it exactly`);
  lines.push(`- The art style of the output MUST be consistent with the character reference images`);
  lines.push(``);
  lines.push(`=== SCENE ENVIRONMENT ===`);
  lines.push(params.sceneDescription);
  lines.push(``);
  lines.push(`=== FRAME DESCRIPTION ===`);
  lines.push(params.startFrameDesc);
  lines.push(``);
  lines.push(`=== CHARACTER DESCRIPTIONS ===`);
  lines.push(params.characterDescriptions);
  lines.push(``);
  lines.push(`=== REFERENCE IMAGES ===`);
  lines.push(`Reference images of each character are attached. You MUST reproduce these characters EXACTLY as they appear in the reference images — same face, same body type, same clothing, same hair, same colors, same art style. Do NOT change their visual style.`);
  lines.push(``);

  if (params.previousLastFrame) {
    lines.push(`=== CONTINUITY REQUIREMENT ===`);
    lines.push(`This shot DIRECTLY follows the previous shot. The attached reference includes the previous shot's final frame. Maintain visual continuity:`);
    lines.push(`- Same characters must appear in consistent outfits and proportions`);
    lines.push(`- Same art style — do NOT switch between anime and photorealism`);
    lines.push(`- Environmental lighting and color temperature should transition smoothly`);
    lines.push(`- Character positions should logically follow from where the previous shot ended`);
    lines.push(``);
  }

  lines.push(`=== RENDERING ===`);
  lines.push(`Textures: Rich detail appropriate to the art style`);
  lines.push(`Lighting: Cinematic lighting with motivated light sources. Use rim lighting for character separation.`);
  lines.push(`Backgrounds: Fully rendered, detailed environment. No blank or abstract backgrounds.`);
  lines.push(`Characters: Match reference images exactly in appearance AND art style. Expressive faces, natural dynamic poses.`);
  lines.push(`Composition: Cinematographic framing with clear focal point and depth-of-field.`);

  return lines.join("\n");
}

export function buildLastFramePrompt(params: {
  sceneDescription: string;
  endFrameDesc: string;
  characterDescriptions: string;
  firstFramePath: string;
}): string {
  const lines: string[] = [];

  lines.push(`Create the CLOSING FRAME of this shot as a single high-quality image.`);
  lines.push(``);
  lines.push(`=== CRITICAL: ART STYLE (HIGHEST PRIORITY) ===`);
  lines.push(`You MUST match the EXACT art style of the first frame image (attached).`);
  lines.push(`If the first frame is anime/manga style → this frame MUST also be anime/manga style.`);
  lines.push(`If the first frame is photorealistic → this frame MUST also be photorealistic.`);
  lines.push(`Do NOT change or mix art styles. This is non-negotiable.`);
  lines.push(``);
  lines.push(`=== SCENE ENVIRONMENT ===`);
  lines.push(params.sceneDescription);
  lines.push(``);
  lines.push(`=== FRAME DESCRIPTION ===`);
  lines.push(params.endFrameDesc);
  lines.push(``);
  lines.push(`=== CHARACTER DESCRIPTIONS ===`);
  lines.push(params.characterDescriptions);
  lines.push(``);
  lines.push(`=== REFERENCE IMAGES ===`);
  lines.push(`The FIRST attached image is the OPENING FRAME of this same shot — use it as your visual anchor for style, environment, and character appearance.`);
  lines.push(`The remaining attached images are character reference sheets — characters MUST look exactly like their references.`);
  lines.push(``);
  lines.push(`=== RELATIONSHIP TO FIRST FRAME ===`);
  lines.push(`This closing frame shows the END STATE of the shot's action. Compared to the first frame:`);
  lines.push(`- Same environment, lighting setup, and color palette`);
  lines.push(`- Same art style — absolutely no style changes`);
  lines.push(`- Identical character appearance (face, outfit, body type)`);
  lines.push(`- Character positions, poses, and expressions have CHANGED as described in the frame description above`);
  lines.push(``);
  lines.push(`=== AS NEXT SHOT'S STARTING POINT ===`);
  lines.push(`This frame will be reused as the next shot's opening frame. Ensure:`);
  lines.push(`- The pose is STABLE — not mid-motion or blurred`);
  lines.push(`- The composition is COMPLETE and works as a standalone frame`);
  lines.push(`- The framing allows natural transition to a different camera angle`);
  lines.push(``);
  lines.push(`=== RENDERING ===`);
  lines.push(`Textures: Rich detail matching the first frame's style`);
  lines.push(`Lighting: Same lighting setup as the first frame. Changes only if motivated by action.`);
  lines.push(`Backgrounds: Must match the first frame's environment.`);
  lines.push(`Characters: Match reference images exactly. Show emotional state at END of the shot's action.`);
  lines.push(`Composition: Natural conclusion of the shot, ready to cut to the next.`);

  return lines.join("\n");
}
