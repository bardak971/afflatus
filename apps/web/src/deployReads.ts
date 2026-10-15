import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/** What is read again once a pod is deployed (the dialog, Deploy again): it is a machine now, it costs, it is one of the account's pods. */
export const DEPLOYED_READS = [queryKeys.settings(), queryKeys.queue(), queryKeys.machines(), queryKeys.runpodPods(), queryKeys.rentedSpending()];

/** The queue and the hunt read again (the dialog's hunt, its change, its cancel): here, so that the dialog and deploy.tsx, which loads it later, do not import each other. */
export const huntReads = (client: QueryClient) => Promise.all([queryKeys.queue(), queryKeys.hunt()].map((queryKey) => client.invalidateQueries({ queryKey })));
