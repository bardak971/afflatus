/**
 * The public half of the key Afflatus releases are signed with (Ed25519, raw, base64): an update is used only when
 * its SHA256SUMS.txt carries a signature this key verifies. The private half is the release workflow's secret
 * AFFLATUS_RELEASE_KEY; it is never in the repository.
 */
export const RELEASE_KEY = "ijPGNXJpj1wLACpxA+yzqM808APDdLpJEhzo4bpQLDw=";
