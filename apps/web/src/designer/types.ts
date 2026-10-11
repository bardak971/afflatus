import type { DesignerReply } from "../api";

/** One thing said in the conversation. What the designer said keeps what it proposed, to use or not. */
export interface DesignerTurn {
  role: "user" | "assistant";
  content: string;
  reply?: DesignerReply;
  /** The proposal was put in the form. */
  used?: boolean;
  /** What the parts it changes held when it was proposed: to show what changed, and to put back. */
  was?: Record<string, string>;
}
