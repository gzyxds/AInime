/**
 * AI vision-based video prompt generation for reference image mode.
 * Given a rendered scene reference frame, generates a Seedance-style video prompt.
 */

export const REF_VIDEO_PROMPT_SYSTEM = `You are a Seedance 2.0 video prompt writer. Given a rendered scene image and screenplay context, write a precise motion prompt in the same language as the screenplay.

## Core principle
The video model already SEES the reference image — it knows what characters look like. Your job is to tell it WHAT MOVES, HOW, and WHEN. Avoid describing appearance; describe action beats.

## Rules
- Match the language of the screenplay context (Chinese screenplay → Chinese prompt, English → English), pure prose, no labels
- On first mention: "Name（visual identifier）" — use EXACTLY the identifier provided in CHARACTER VISUAL IDs below (if provided). Never invent alternatives.
- Camera movement: be specific — "slow push-in", "static", "rack focus from X to Y", "handheld drift"
- Break the action into precise beats with clear causality: what happens first → then → result
- Each beat should describe physical motion: distance, speed, direction, texture of movement
- No filler adjectives ("gracefully", "gently", "softly") unless they specify HOW something moves
- Atmospheric/environment details only if they MOVE (swaying branches, rising mist, flickering light)
- 40-70 words
- If dialogue provided, keep it in original language on its own final line: 【对白口型】Name（visual identifier）: "原文台词"
- Output prompt only, no preamble

## Quality benchmark

BAD (vague, appearance-focused):
His fingers glow with warmth as he gracefully places the piece. The atmosphere is serene and beautiful.

GOOD (precise, motion-focused):
Camera static. Yi-zhe (pale blue robe) pinches the jade piece and lowers it in a dead-slow arc through the morning mist. Contact — the board surface shudders, a dew drop rolls. His hand holds for one beat, then withdraws in a single smooth pull. Rack focus from fingertip to settled stone. Willow branches drift in the background.`;

export function buildRefVideoPromptRequest(params: {
  motionScript: string;
  cameraDirection: string;
  duration: number;
  characters?: Array<{ name: string; visualHint?: string | null }>;
  dialogues?: Array<{ characterName: string; text: string; offscreen?: boolean; visualHint?: string }>;
}): string {
  const lines: string[] = [
    `Based on the rendered scene image above, write a Seedance-style video prompt in the same language as the screenplay action below.`,
    ``,
  ];

  const withHints = (params.characters ?? []).filter((c) => c.visualHint);
  if (withHints.length) {
    lines.push(`CHARACTER VISUAL IDs (MANDATORY — use verbatim when mentioning each character):`);
    for (const c of withHints) {
      lines.push(`  ${c.name}：${c.visualHint}`);
    }
    lines.push(``);
  }

  lines.push(`Screenplay action: ${params.motionScript}`);
  lines.push(`Camera direction: ${params.cameraDirection}`);
  lines.push(`Duration: ${params.duration}s`);

  if (params.dialogues?.length) {
    lines.push(`Dialogue: ${params.dialogues.map(d => `${d.characterName}: "${d.text}"`).join("; ")}`);
  }

  return lines.join("\n");
}
