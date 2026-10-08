# Projects — the plan

Settled on 2026-10-04, from two questions that turned out to be one: the timeline's media shelf
will not scale past a handful of items, and the todo asked what a draft is next to a "project".

## The model

- **A project** is the thing the switcher picks. It owns drafts, timelines and folders. It has a name, a root
  folder, and can be archived (hidden with everything in it, nothing deleted).
- **Folders live inside a project**, as they are today (a tree, linked to a directory or not). A folder's
  project is that of its top ancestor; a top-level folder made with no project is in the **Inbox**, which is
  everything that is in no project — what exists today.
- **Drafts stay.** They are the Studio's unit of work: a form with its model, texts, cast, conversation and
  results. A draft belongs to a project (or the Inbox); what it makes lands in a folder of that project, the
  root unless another is open.
- **A timeline** belongs to a project and names a folder in it for its renders (the root by default).
- **Linked folders** are unchanged and belong to a project like any folder. A project whose root is linked
  *is* a directory on disk: its renders and exports are files there, and files dropped there appear in it.
- **The switcher is global**: All · Inbox · one project, in the rail under the name. It scopes the Library,
  the Studio's drafts, the Timelines list and the timeline's media shelf in one move. Forms never scope.
- No nesting of projects, no project spanning several top folders: a project, then one tree of folders. A
  power user gets a project per film with bins inside; a beginner gets one project with everything at its root.

## Slices

1. **Server**: `projects` table; `project_id` on folders, drafts and timelines; `folder_id` on timelines;
   routes to list / create / rename / archive / delete a project (delete detaches, nothing is removed);
   `project=` filters on assets, drafts and timelines; a folder made at the top takes a project, one made inside
   inherits; a timeline's renders land in its folder.
2. **Web**: the switcher in the rail (kept per browser); the Library's folder panel and list scoped; Studio's
   draft list scoped and a new draft made in the current project, its results into the project's root when no
   folder is open; the Timelines list scoped and a new timeline made in the project; a project's row to rename,
   archive, delete.
3. **The shelf** (built 2026-10-04): scopes Project · Recent · Kept · All, a search box (the "/" key), a sort; the project's media
   by default plus what the timeline already uses; a draggable edge and a collapse to a rail; grouped by day,
   paged.
4. **Built 2026-10-04**: "Browse the library" from the shelf as a full picker that inserts on click; "Add to timeline N"
   in a tile's menu.
