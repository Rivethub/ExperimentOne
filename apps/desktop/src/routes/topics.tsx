import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useApp } from "#app/context";
import { topicArchiveSlug, topicWikiPageId } from "#components/wiki-board-logic";
import { runApp } from "#effect";
import * as Rivet from "#effect/rivet";
import { useTopics } from "#hooks";
import { TopicsPane, type TopicCard, type TopicKnowledge } from "#panes";

export const Route = createFileRoute("/topics")({
  component: TopicsPage,
});

function TopicsPage(): React.ReactElement {
  const { busy } = useApp();
  const navigate = useNavigate();
  const topics = useTopics();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const loadArchive = useCallback(
    (projectId: string, slug: string, file: string) =>
      runApp(Rivet.loadWikiArchiveContent(slug, file, projectId)),
    [],
  );

  const loadKnowledge = useCallback(async (topic: TopicCard): Promise<TopicKnowledge> => {
    const projectId = topic.project_id?.trim() || "default";
    const pageId = topicWikiPageId(projectId, topic.slug, topic.kind);
    const archiveSlug = topicArchiveSlug(topic.slug, topic.kind);
    let body: string | null = null;
    if (pageId) {
      try {
        body = await runApp(
          Rivet.loadWikiPageContent({
            id: pageId,
            project_id: projectId,
            title: topic.title,
            path: "",
            relative_path: "",
            folder: "",
            updated_at: topic.updated_at,
            preview: "",
          }),
        );
      } catch {
        body = null;
      }
    }
    let archives: string[] = [];
    if (archiveSlug) {
      try {
        archives = await runApp(Rivet.loadWikiArchiveList(archiveSlug, projectId));
      } catch {
        archives = [];
      }
    }
    return { body, archives, archiveSlug, projectId };
  }, []);

  return (
    <TopicsPane
      active
      topics={topics.topics}
      tidy={topics.tidy}
      tags={topics.tags}
      flagged={topics.flagged}
      busy={busy}
      selectedSlug={selectedSlug}
      onSelect={setSelectedSlug}
      onOpenSession={(sessionId) => {
        void navigate({
          to: "/data/c/$conversationId",
          params: { conversationId: sessionId },
          search: { q: sessionId, mode: "keyword", thread: "" },
        });
      }}
      onFilterData={(query) => {
        void navigate({
          to: "/data",
          search: { q: query, mode: "keyword", thread: "" },
        });
      }}
      onTidyDecide={(id, status) => {
        void topics.decideTidy(id, status);
      }}
      onTagDecide={(id, status) => {
        void topics.decideTag(id, status);
      }}
      onFlaggedRetry={(task, jobKey) => {
        void topics.retryFlagged(task, jobKey);
      }}
      loadKnowledge={loadKnowledge}
      loadArchive={loadArchive}
    />
  );
}
