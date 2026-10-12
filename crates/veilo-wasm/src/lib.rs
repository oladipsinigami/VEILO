use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn memo_size() -> usize { veilo_core::memo::MEMO_SIZE }
