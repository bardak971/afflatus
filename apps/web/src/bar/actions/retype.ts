import { useBar } from "../store";
import type { Action } from "./ctx";

/** The bar's line set to `line`: a value row's "its renders alone", a prompt's "its renders". */
export const retype = (line: string): Action["run"] => () => useBar.getState().retype(line);
