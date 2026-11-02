import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FaceRoute } from "../../api";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, Help } from "../../ui";

/** Why a continuation with the same person pictures is face-refined rather than sampled with them: the "?" of the line. */
const WHY =
  "Sampled with a person's picture, a continuation takes on the picture's colour and light, more with each clip (a beach chain went yellow and brighter by its fourth clip). So a continuation with the same person pictures as the clip before is sampled without them, carrying on from that clip's frames, and Face refine then draws the face towards them: the colour stays the scene's. A clip whose person pictures changed is sampled with them, a new look being asked for there, and the clips after it carry that face on.";

/** What each H3 clip of a timeline does with its person's picture, by clip id (card #223); read again with the timeline. */
export function useFaceRoutes(timeline: string): Record<string, FaceRoute> {
  return useQuery({ queryKey: queryKeys.timelines.face(timeline), queryFn: () => api.faceRoutes(timeline), staleTime: 30_000 }).data?.clips ?? {};
}

/** The clips counted from `from` to `to`, said as the timeline says them. */
const clipsSaid = (r: { from: number; to: number }) => (r.from === r.to ? `Clip ${r.from} still has` : `Clips ${r.from}–${r.to} still have`);

/**
 * One line at the top of a clip's references: what this clip does with its person's picture, why in its "?", and for a clip
 * whose picture changed, the clips after it still on the old one and Use this one on them too. Nothing for a clip with none.
 */
export function FaceLine({ timeline, clip, route }: { timeline: string; clip: string; route: FaceRoute | undefined }) {
  const client = useQueryClient();
  const failed = useSayFailed({ here: true });
  const spread = useMutation({
    mutationFn: () => api.spreadFace(clip),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.timelines.one(timeline) }),
    onError: failed("Not given to the clips after"),
  });
  if (!route) return null;
  const said =
    route.route === "carried" && route.held === false ? `A plain continuation of clip ${route.before}, sampled without the person's picture and not face-refined (Hold the face on continuations is off): the face may drift from it.`
    : route.route === "carried" ? `On this continuation the face comes from Face refine towards the person's picture, carried on from clip ${route.before}.`
    : route.why === "changed" ? `This clip starts a new look: sampled with the person's picture, which differs from clip ${route.before}'s.`
    : "Sampled with the person's picture: the clips that carry on from this one keep its face by Face refine.";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-xs text-ink-2" data-face-route={route.route}>
      <span className="flex items-start gap-1">
        <span className="grow">{said}</span>
        <Help text={WHY} title="Person picture on continuations" />
      </span>
      {route.keepOld && (
        <span className="flex flex-wrap items-center gap-2">
          <span>{clipsSaid(route.keepOld)} clip {route.before}'s picture: {route.keepOld.from === route.keepOld.to ? "it would be" : "they would be"} sampled with the old face again.</span>
          <Button size="sm" disabled={spread.isPending} onClick={() => spread.mutate()}>Use this one on them too</Button>
        </span>
      )}
    </div>
  );
}
