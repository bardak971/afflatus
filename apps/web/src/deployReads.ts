import { queryKeys } from "./queryKeys";

/** What is read again once a pod is deployed (the dialog, Deploy again): it is a machine now, it costs, it is one of the account's pods. */
export const DEPLOYED_READS = [queryKeys.settings(), queryKeys.queue(), queryKeys.machines(), queryKeys.runpodPods(), queryKeys.rentedSpending()];
