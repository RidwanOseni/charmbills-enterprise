/**
 * Extracts and verifies spell data from a Bitcoin transaction.
 * @param tx The transaction object { bitcoin: "hex" }
 * @param mock Whether to use mock verification
 */
export function extractAndVerifySpell(tx: any, mock: boolean): any;

/**
 * The default export is the WASM initialization function.
 * In v0.12.0, this must be awaited before any other calls [3].
 */
const init: () => Promise<void>;
export default init;