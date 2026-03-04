let wasm;

export default async function initWasm() {
    if (wasm) return wasm;
    const response = await fetch('/charms_lib_bg.wasm'); // Ensure .wasm is in /public folder
    const buffer = await response.arrayBuffer();
    const module = await WebAssembly.compile(buffer);
    const instance = await WebAssembly.instantiate(module, __wbg_get_imports());
    wasm = instance.exports;
    return wasm;
}

// Ensure the export exists for the utility to find
export function extractAndVerifySpell(tx, mock) {
    const ret = wasm.extractAndVerifySpell(tx, mock);
    return takeFromExternrefTable0(ret);
}