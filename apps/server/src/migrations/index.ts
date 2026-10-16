import type { Migration } from "kysely/migration";
import m0001 from "./0001-settings";
import m0002 from "./0002-library-and-queue";
import m0003 from "./0003-drafts";
import m0004 from "./0004-model-settings";
import m0005 from "./0005-workflows";
import m0006 from "./0006-model-info";
import m0007 from "./0007-timelines";
import m0008 from "./0008-timeline-editor";
import m0009 from "./0009-people";
import m0010 from "./0010-mood";
import m0011 from "./0011-clip-chat";
import m0012 from "./0012-draft-name";
import m0013 from "./0013-model-pages";
import m0014 from "./0014-designer-session";
import m0015 from "./0015-model-words";
import m0016 from "./0016-job-draft-folder";
import m0017 from "./0017-linked-folders";
import m0018 from "./0018-job-warm";
import m0019 from "./0019-trails";
import m0020 from "./0020-render-times";
import m0021 from "./0021-afflatus";
import m0022 from "./0022-source-range";
import m0023 from "./0023-projects";
import m0024 from "./0024-redo";
import m0025 from "./0025-finish";
import m0026 from "./0026-raw";
import m0027 from "./0027-latent";
import m0028 from "./0028-join-kind";
import m0029 from "./0029-folder-chosen";
import m0030 from "./0030-model-updates";
import m0031 from "./0031-take-lead";
import m0032 from "./0032-job-timeline";
import m0033 from "./0033-countdown-from";
import m0034 from "./0034-render-work";
import m0035 from "./0035-finished-grid";
import m0036 from "./0036-fine-latent";
import m0037 from "./0037-job-warning";
import m0038 from "./0038-indexes";
import m0039 from "./0039-wide-sizes";
import m0040 from "./0040-asked";
import m0041 from "./0041-generation-measure";
import m0042 from "./0042-drop-take-lead";
import m0043 from "./0043-lost-root-folders";
import m0044 from "./0044-timelines-follow-folders";
import m0045 from "./0045-music-duck-db";
import m0046 from "./0046-auto-names";
import m0047 from "./0047-label-names";
import m0048 from "./0048-music-place";
import m0049 from "./0049-clip-fit";
import m0050 from "./0050-job-error-trace";
import m0051 from "./0051-review-indexes";
import m0052 from "./0052-library-search";
import m0053 from "./0053-render-digests";
import m0054 from "./0054-pin-mirror";
import m0055 from "./0055-aggregate-indexes";
import m0056 from "./0056-machines";
import m0057 from "./0057-kit-cutouts";
import m0058 from "./0058-no-cutouts";
import m0059 from "./0059-rent-sessions";
import m0060 from "./0060-drop-kit-for";
import m0061 from "./0061-rent-seen";
import m0062 from "./0062-pod-measures";
import m0063 from "./0063-model-sets";
import m0064 from "./0064-pod-measures-wide";
import m0065 from "./0065-volume-files";
import m0066 from "./0066-model-hashes";
import m0067 from "./0067-clip-transition";
import m0068 from "./0068-timeline-source";
import m0069 from "./0069-sessions";
import m0070 from "./0070-render-machines";
import m0071 from "./0071-costs";
import m0072 from "./0072-motion-work";
import m0073 from "./0073-render-work";
import m0074 from "./0074-rent-busy";
import m0075 from "./0075-kept-bytes";
import m0076 from "./0076-rent-boot";
import m0077 from "./0077-pod-outside";
import m0078 from "./0078-session-volume";

/**
 * Every migration by its name, in the order they run (Kysely sorts them by name). A name never changes once
 * released: the databases out there record what ran by it. Written with Kysely's schema builder, for both
 * databases; the few steps the two spell differently ask onPostgres (dialect.ts).
 */
export const migrations: Record<string, Migration> = {
  "0001_settings": m0001,
  "0002_library_and_queue": m0002,
  "0003_drafts": m0003,
  "0004_model_settings": m0004,
  "0005_workflows": m0005,
  "0006_model_info": m0006,
  "0007_timelines": m0007,
  "0008_timeline_editor": m0008,
  "0009_people": m0009,
  "0010_mood": m0010,
  "0011_clip_chat": m0011,
  "0012_draft_name": m0012,
  "0013_model_pages": m0013,
  "0014_designer_session": m0014,
  "0015_model_words": m0015,
  "0016_job_draft_folder": m0016,
  "0017_linked_folders": m0017,
  "0018_job_warm": m0018,
  "0019_trails": m0019,
  "0020_render_times": m0020,
  "0021_afflatus": m0021,
  "0022_source_range": m0022,
  "0023_projects": m0023,
  "0024_redo": m0024,
  "0025_finish": m0025,
  "0026_raw": m0026,
  "0027_latent": m0027,
  "0028_join_kind": m0028,
  "0029_folder_chosen": m0029,
  "0030_model_updates": m0030,
  "0031_take_lead": m0031,
  "0032_job_timeline": m0032,
  "0033_countdown_from": m0033,
  "0034_render_work": m0034,
  "0035_finished_grid": m0035,
  "0036_fine_latent": m0036,
  "0037_job_warning": m0037,
  "0038_indexes": m0038,
  "0039_wide_sizes": m0039,
  "0040_asked": m0040,
  "0041_generation_measure": m0041,
  "0042_drop_take_lead": m0042,
  "0043_lost_root_folders": m0043,
  "0044_timelines_follow_folders": m0044,
  "0045_music_duck_db": m0045,
  "0046_auto_names": m0046,
  "0047_label_names": m0047,
  "0048_music_place": m0048,
  "0049_clip_fit": m0049,
  "0050_job_error_trace": m0050,
  "0051_review_indexes": m0051,
  "0052_library_search": m0052,
  "0053_render_digests": m0053,
  "0054_pin_mirror": m0054,
  "0055_aggregate_indexes": m0055,
  "0056_machines": m0056,
  "0057_kit_cutouts": m0057,
  "0058_no_cutouts": m0058,
  "0059_rent_sessions": m0059,
  "0060_drop_kit_for": m0060,
  "0061_rent_seen": m0061,
  "0062_pod_measures": m0062,
  "0063_model_sets": m0063,
  "0064_pod_measures_wide": m0064,
  "0065_volume_files": m0065,
  "0066_model_hashes": m0066,
  "0067_clip_transition": m0067,
  "0068_timeline_source": m0068,
  "0069_sessions": m0069,
  "0070_render_machines": m0070,
  "0071_costs": m0071,
  "0072_motion_work": m0072,
  "0073_render_work": m0073,
  "0074_rent_busy": m0074,
  "0075_kept_bytes": m0075,
  "0076_rent_boot": m0076,
  "0077_pod_outside": m0077,
  "0078_session_volume": m0078,
};
