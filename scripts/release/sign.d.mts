// The types of sign.mjs, for the tests that import it (apps/server/test/releaseSign.test.ts).
export declare function signBytes(data: Uint8Array, privatePem: string): string;
export declare function publicKeyOf(privatePem: string): string;
export declare function verifyBytes(data: Uint8Array, signature: string, publicKey: string): boolean;
