/**
 * The reading page: Connected's surface with everything the combined
 * direction adds. Above the column, the session bar when the reading is on
 * the desk (or the desk toggle when it could be); under the tags, the
 * mentions row; beside the column, the thread strip above the relationship
 * cards, then Worth revisiting and More like this after them.
 */
import { useEffect } from "react";
import { useStudy } from "../context";
import { ReadingSurface, ReadingUnavailable } from "../shared";
import { threadFor, threadsOf } from "../study";
import { DeskToggle, SessionBar } from "./Desk";
import { MentionsRow, MoreLikeThis } from "./Catalog";
import { RevisitGroup, ThreadStrip } from "./Threads";

export function ReadingPage() {
  const { route, items, lookup, deskIds, scenario, setSampleStep } = useStudy();
  const found = lookup(route.id);
  const sample = found?.sample ?? false;
  // Opening a sample completes the new reader's first step.
  useEffect(() => {
    if (sample && scenario === "new-reader") setSampleStep(1);
  }, [sample, scenario, setSampleStep]);
  if (!found) return <ReadingUnavailable />;
  const { reading } = found;
  const thread = threadFor(threadsOf(items), reading.id);
  const onDesk = deskIds.includes(reading.id);
  return (
    <ReadingSurface
      reading={reading}
      sample={sample}
      before={onDesk ? <SessionBar reading={reading} /> : reading.status === "ready" && !sample ? <div className="session-bar session-bar-quiet"><DeskToggle reading={reading} /></div> : undefined}
      afterMeta={!sample ? <MentionsRow reading={reading} /> : undefined}
      contextTop={thread ? <ThreadStrip thread={thread} reading={reading} /> : undefined}
      contextExtra={!sample ? <><RevisitGroup reading={reading} /><MoreLikeThis reading={reading} /></> : undefined}
    />
  );
}
