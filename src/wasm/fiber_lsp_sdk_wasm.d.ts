/* tslint:disable */
/* eslint-disable */

/**
 * Construct exact cooperative-close outputs and fee from trusted terms. The
 * remote proposal and committed transaction must match this template.
 */
export function close_template(args: string): string;

export function create_identity(): Promise<string>;

export function execute(root: Uint8Array, snapshot: string, state: string, command: string): Promise<string>;

export function pack_script(script: string): string;

export function parse_invoice(invoice: string): string;

export function payment_hash(preimage: Uint8Array, algorithm: string): string;

export function transaction_hash(transaction: string): string;

export function validate_public_key(value: string): void;

export function verify_invoice_response(address: string, body: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly close_template: (a: number, b: number) => [number, number, number, number];
    readonly create_identity: () => any;
    readonly execute: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
    readonly pack_script: (a: number, b: number) => [number, number, number, number];
    readonly parse_invoice: (a: number, b: number) => [number, number, number, number];
    readonly payment_hash: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly transaction_hash: (a: number, b: number) => [number, number, number, number];
    readonly validate_public_key: (a: number, b: number) => [number, number];
    readonly verify_invoice_response: (a: number, b: number, c: number, d: number) => [number, number];
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly wasm_bindgen_c2001ebd311e00d5___convert__closures_____invoke___wasm_bindgen_c2001ebd311e00d5___JsValue__core_9b3796e30d99ddb7___result__Result_____wasm_bindgen_c2001ebd311e00d5___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_c2001ebd311e00d5___convert__closures_____invoke___js_sys_50c6fd65d58b7899___Function_fn_wasm_bindgen_c2001ebd311e00d5___JsValue_____wasm_bindgen_c2001ebd311e00d5___sys__Undefined___js_sys_50c6fd65d58b7899___Function_fn_wasm_bindgen_c2001ebd311e00d5___JsValue_____wasm_bindgen_c2001ebd311e00d5___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
