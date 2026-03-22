import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
  title: text("title").notNull(),
  idea: text("idea").default(""),
  script: text("script").default(""),
  status: text("status", {
    enum: ["draft", "processing", "completed"],
  })
    .notNull()
    .default("draft"),
  finalVideoUrl: text("final_video_url"),
  generationMode: text('generation_mode', { enum: ['keyframe', 'reference'] }).notNull().default('keyframe'),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").default(""),
  visualHint: text("visual_hint").default(""),
  referenceImage: text("reference_image"),
});

export const storyboardVersions = sqliteTable("storyboard_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  versionNum: integer("version_num").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const shots = sqliteTable("shots", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  prompt: text("prompt").default(""),
  startFrameDesc: text("start_frame_desc"),
  endFrameDesc: text("end_frame_desc"),
  motionScript: text("motion_script"),
  cameraDirection: text("camera_direction").default("static"),
  duration: integer("duration").notNull().default(10),
  firstFrame: text("first_frame"),
  lastFrame: text("last_frame"),
  videoUrl: text("video_url"),
  referenceVideoUrl: text("reference_video_url"),
  lastFrameUrl: text("last_frame_url"),
  sceneRefFrame: text("scene_ref_frame"),
  videoScript: text("video_script"),
  videoPrompt: text("video_prompt"),
  versionId: text("version_id").references(() => storyboardVersions.id, {
    onDelete: "cascade",
  }),
  status: text("status", {
    enum: ["pending", "generating", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
});

export const dialogues = sqliteTable("dialogues", {
  id: text("id").primaryKey(),
  shotId: text("shot_id")
    .notNull()
    .references(() => shots.id, { onDelete: "cascade" }),
  characterId: text("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  audioUrl: text("audio_url"),
  sequence: integer("sequence").notNull().default(0),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  type: text("type", {
    enum: [
      "script_parse",
      "character_extract",
      "character_image",
      "shot_split",
      "frame_generate",
      "video_generate",
      "video_assemble",
    ],
  }).notNull(),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed"],
  })
    .notNull()
    .default("pending"),
  payload: text("payload", { mode: "json" }),
  result: text("result", { mode: "json" }),
  error: text("error"),
  retries: integer("retries").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
});
