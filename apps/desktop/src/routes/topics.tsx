import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import { Effect } from "effect";
import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import { useApp } from "#app/context";
import { topicArchiveSlug, topicWikiPageId } from "#components/wiki-board-logic";
import { runApp, softEffect } from "#effect";
import * as Rivet from "#effect/rivet";
import { useTopics } from "#hooks";
import { TopicsPane, type TopicCard, type TopicKnowledge } from "#panes";

export const Route = createFileRoute("/topics")({
  component: TopicsPage,
});

function TopicsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const topics = useTopics();
  const [selectedSlug, setSelectedSlug] = createSignal<string | null>(null);

  const loadArchive = (projectId: string, slug: string, file: string) =>
    runApp(Rivet.loadWikiArchiveContent(slug, file, projectId));
  const loadKnowledge = async (topic: TopicCard): Promise<TopicKnowledge> => {
    const projectId = topic.project_id?.trim() || "default";
    const pageId = topicWikiPageId(projectId, topic.slug, topic.kind);
    const archiveSlug = topicArchiveSlug(topic.slug, topic.kind);
    return runApp(
      Effect.gen(function* loadTopicKnowledge() {
        const [body, archives] = yield* Effect.all(
          [
            pageId
              ? softEffect(
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
                )
              : Effect.succeed(null),
            archiveSlug
              ? softEffect(Rivet.loadWikiArchiveList(archiveSlug, projectId))
              : Effect.succeed(null),
          ],
          { concurrency: "unbounded" },
        );
        return {
          body,
          archives: archives ?? [],
          archiveSlug,
          projectId,
        };
      }),
    );
  };

  return (
    <TopicsPane
      active
      topics={topics.topics}
      tidy={topics.tidy}
      tags={topics.tags}
      flagged={topics.flagged}
      busy={app.busy()}
      selectedSlug={selectedSlug()}
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
