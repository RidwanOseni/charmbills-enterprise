/* @ts-self-types="./subscription_engine.d.ts" */

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
    };
    return {
        __proto__: null,
        "./charms_lib_bg.js": import0,
    };
}

const wasmPath = `${__dirname}/charms_lib_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasm = new WebAssembly.Instance(wasmModule, __wbg_get_imports()).exports;
