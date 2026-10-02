// jose 6 is ESM-only and cannot load under ts-jest CJS. Integration tests never verify Apple/Google ID tokens.
export const jwtVerify = async (): Promise<never> => {
  throw new Error('jose is stubbed in integration tests');
};
export const createRemoteJWKSet = (): (() => never) => () => {
  throw new Error('jose is stubbed in integration tests');
};
