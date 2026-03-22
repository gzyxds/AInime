"use client";

import { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/project-store";
import { useModelStore } from "@/stores/model-store";
import { useTranslations } from "next-intl";
import { Sparkles, Save, Loader2, FileText, Lightbulb } from "lucide-react";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { apiFetch } from "@/lib/api-fetch";
import { useModelGuard } from "@/hooks/use-model-guard";
import { toast } from "sonner";

export function ScriptEditor() {
  const t = useTranslations();
  const { project, updateIdea, updateScript, fetchProject } = useProjectStore();
  const getModelConfig = useModelStore((s) => s.getModelConfig);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const textGuard = useModelGuard("text");
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (generating && scriptTextareaRef.current) {
      const el = scriptTextareaRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [project?.script, generating]);

  if (!project) return null;

  async function handleSave() {
    if (!project) return;
    setSaving(true);
    await apiFetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea: project.idea, script: project.script }),
    });
    setSaving(false);
  }

  async function handleGenerateScript() {
    if (!project) return;
    if (!textGuard()) return;
    setGenerating(true);

    const idea = project.idea || "";
    updateScript("");

    try {
      const response = await apiFetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "script_generate",
          payload: { idea },
          modelConfig: getModelConfig(),
        }),
      });

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += decoder.decode(value, { stream: true });
          updateScript(fullText);
        }
      }

      await fetchProject(project.id);
    } catch (err) {
      console.error("Script generate error:", err);
      toast.error(t("common.generationFailed"));
    }

    setGenerating(false);
  }

  return (
    <div className="animate-page-in space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/8">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <h2 className="font-display text-xl font-bold tracking-tight text-[--text-primary]">
            {t("project.script")}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <InlineModelPicker capability="text" />
          <Button
            onClick={handleSave}
            variant="outline"
            size="sm"
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("common.save")}
          </Button>
          <Button
            onClick={handleGenerateScript}
            disabled={generating || !project.idea?.trim()}
            size="sm"
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {generating ? t("common.generating") : t("project.generateScript")}
          </Button>
        </div>
      </div>

      {/* Idea input */}
      <div className="rounded-2xl border border-[--border-subtle] bg-white p-1.5">
        <div className="flex items-center gap-2 px-5 pt-3 pb-1">
          <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
            {t("project.idea")}
          </span>
        </div>
        <Textarea
          value={project.idea}
          onChange={(e) => updateIdea(e.target.value)}
          placeholder={t("project.scriptIdeaPlaceholder")}
          rows={4}
          disabled={generating}
          className={`h-[30vh] resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-5 pb-4 font-mono text-sm leading-relaxed placeholder:text-[--text-muted] focus-visible:ring-0 ${
            generating ? "opacity-40" : ""
          }`}
        />
      </div>

      {/* Generated script */}
      {project.script && (
        <div className="rounded-2xl border border-[--border-subtle] bg-white p-1.5">
          <div className="flex items-center gap-2 px-5 pt-3 pb-1">
            <FileText className="h-3.5 w-3.5 text-primary" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
              {t("project.generatedScript")}
            </span>
          </div>
          <Textarea
            ref={scriptTextareaRef}
            value={project.script}
            onChange={(e) => updateScript(e.target.value)}
            rows={16}
            disabled={generating}
            className={`h-[55vh] resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-5 pb-4 font-mono text-sm leading-relaxed placeholder:text-[--text-muted] focus-visible:ring-0 ${
              generating ? "opacity-40" : ""
            }`}
          />
        </div>
      )}
    </div>
  );
}
