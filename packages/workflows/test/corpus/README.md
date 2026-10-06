# The importer's corpus

Drop ComfyUI workflow files here (`.json` as the editor saves them, or exported) to check the importer
against real workflows: `corpus.test.ts` reads every one, inspects it against the reference catalog, and
compares what it found (a prompt, a model file, an output, how many node types are missing, how many stages)
with `expect.json`. A workflow that maps less than before fails the test; one that maps more is reported.

The files stay local (they are other people's work): only `expect.json`, which holds names and counts,
is committed. `pnpm corpus:expect` writes `expect.json` from what the importer finds today.
