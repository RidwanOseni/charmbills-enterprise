use charms_sdk::data::{
    charm_values, sum_token_amount, App, Data, Transaction, UtxoId, B32, NFT, TOKEN,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;

// Conditional imports for WASM bridge - only included when building with 'wasm-bridge' feature
#[cfg(feature = "wasm-bridge")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm-bridge")]
use std::collections::HashMap;

// --------------------------------------------------------------------------------
// WASM Bridge Panic Hook and Initialization
// This ensures Rust panics show up in Node.js console logs
// --------------------------------------------------------------------------------

#[cfg(feature = "wasm-bridge")]
#[wasm_bindgen(start)]
pub fn start() {
    // This ensures Rust panics show up in your 'npm run dev' logs
    console_error_panic_hook::set_once();
}

// --------------------------------------------------------------------------------
// Strict Type-Marshalling Bridge Variables Structure
// This replaces the find-and-replace logic with typed marshalling
// --------------------------------------------------------------------------------

#[cfg(feature = "wasm-bridge")]
#[derive(Deserialize)]
pub struct BridgeVariables {
    pub type_name: String,           // "mint-nft" or "mint-token"
    pub anchor_utxo: String,
    pub funding_utxo: String,
    pub ticker: String,
    pub remaining: String,
    pub metadata_hash: String,
    pub scroll_policy: String,
    pub pay_period_seconds: String,
    pub compensation_sats: String,
    pub treasury_dest: String,
    pub app_id: String,
    pub app_vk: String,
    pub worker_dests: Option<Vec<String>>,   // For batch hiring
    pub token_amounts: Option<Vec<String>>,  // For batch hiring
}

// --------------------------------------------------------------------------------
// NFT Content Structure for Payroll
// --------------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NftContent {
    pub ticker: String,
    pub remaining: u64,
    pub metadata_hash: String,
    pub scroll_policy: u8,
    pub pay_period_seconds: u64,
    pub compensation_sats: u64,
}

impl NftContent {
    pub fn validate(&self) -> bool {
        if self.ticker.is_empty() {
            return false;
        }
        if self.metadata_hash.is_empty() {
            return false;
        }
        if self.pay_period_seconds == 0 {
            return false;
        }
        if self.scroll_policy > 1 {
            return false;
        }
        if self.compensation_sats < 1000 {
            return false;
        }
        true
    }
    
    pub fn is_time_based(&self) -> bool {
        self.scroll_policy == 0
    }
    
    pub fn is_proof_based(&self) -> bool {
        self.scroll_policy == 1
    }
}

// --------------------------------------------------------------------------------
// Main App Contract Entry Point
// --------------------------------------------------------------------------------
// This function is for the Charms ZK-VM, not for JavaScript.
// wasm-bindgen cannot handle the complex Charms SDK types (App, Transaction, Data).
pub fn app_contract(app: &App, tx: &Transaction, _x: &Data, w: &Data) -> bool {
    let _ = _x.bytes();
    match app.tag {
        NFT => nft_contract_satisfied(app, tx, w),
        TOKEN => token_contract_satisfied(app, tx),
        _ => false,
    }
}

// --------------------------------------------------------------------------------
// NFT Contract Logic
// --------------------------------------------------------------------------------
fn nft_contract_satisfied(app: &App, tx: &Transaction, w: &Data) -> bool {
    // =========================================================================
    // DEBUG: Log the witness and expected identity to identify mismatch
    // This helps debug the "app_contract assertion failed" error
    // =========================================================================
    let w_str = match w.value::<String>() {
        Ok(val) => {
            eprintln!("\n--- [ZK-DEBUG] NFT Contract Debug ---");
            eprintln!("Witness (w_str): {:?}", val);
            eprintln!("Expected App Identity: {:?}", app.identity.to_string());
            val
        },
        Err(e) => {
            eprintln!("❌ Error: Failed to decode witness as String: {:?}", e);
            return false;
        },
    };
    
    // Compare the witness with the app identity (SHA256 hash of the anchor UTXO)
    let witness_hash = hash(&w_str);
    eprintln!("Witness Hash: {:?}", witness_hash.to_string());
    eprintln!("App Identity:  {:?}", app.identity.to_string());
    
    if witness_hash != app.identity {
        eprintln!("❌ Error: Witness hash does not match App Identity!");
        eprintln!("   Expected: {}", app.identity.to_string());
        eprintln!("   Got:      {}", witness_hash.to_string());
        return false;
    }
    eprintln!("✅ Witness hash matches App Identity");
    
    // Try to parse witness as UTXO ID for minting detection
    let w_utxo_id = match UtxoId::from_str(&w_str) {
        Ok(id) => {
            eprintln!("✅ Parsed witness as UTXO ID: {:?}", id);
            id
        },
        Err(e) => {
            eprintln!("⚠️  Witness is not a valid UTXO ID (this may be fine): {:?}", e);
            // Return false because for NFT minting, witness must be a UTXO ID
            return false;
        },
    };
    
    // Check if this is an NFT minting transaction (witness UTXO appears in inputs)
    let is_nft_minting = tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id);
    eprintln!("Is NFT Minting Transaction: {}", is_nft_minting);
    
    if is_nft_minting {
        // Verify witness UTXO is actually in inputs (redundant check but safe)
        if !tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id) {
            eprintln!("❌ Error: Witness UTXO not found in transaction inputs");
            return false;
        }
        eprintln!("✅ Witness UTXO found in transaction inputs");
    }
    
    // Collect NFT outputs from the transaction
    let nft_outputs: Vec<&Data> = charm_values(app, tx.outs.iter()).collect();
    eprintln!("NFT Outputs found: {}", nft_outputs.len());
    
    if nft_outputs.is_empty() {
        eprintln!("❌ Error: No NFT outputs found");
        return false;
    }
    
    // For NFT minting, there should be exactly one NFT output
    if is_nft_minting && nft_outputs.len() != 1 {
        eprintln!("❌ Error: NFT minting requires exactly 1 NFT output, got {}", nft_outputs.len());
        return false;
    }
    
    // Validate each NFT output's content
    for (i, data) in nft_outputs.iter().enumerate() {
        let content: NftContent = match data.value() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("❌ Error: Failed to decode NFT content at index {}: {:?}", i, e);
                return false;
            },
        };
        
        eprintln!("NFT Output {}: ticker={}, remaining={}, scrollPolicy={}", 
                  i, content.ticker, content.remaining, content.scroll_policy);
        
        if !content.validate() {
            eprintln!("❌ Error: NFT content validation failed at index {}", i);
            return false;
        }
        
        if is_nft_minting && i == 0 {
            if content.ticker.is_empty() {
                eprintln!("❌ Error: NFT ticker is empty");
                return false;
            }
            eprintln!("✅ NFT content validated successfully");
        }
    }
    
    eprintln!("✅ NFT Contract Satisfied!\n");
    true
}

// --------------------------------------------------------------------------------
// Token Contract Logic
// --------------------------------------------------------------------------------
fn token_contract_satisfied(token_app: &App, tx: &Transaction) -> bool {
    can_mint_token(token_app, tx)
}

// --------------------------------------------------------------------------------
// Token Minting Validation
// --------------------------------------------------------------------------------
fn can_mint_token(token_app: &App, tx: &Transaction) -> bool {
    eprintln!("\n--- [ZK-DEBUG] Token Mint Start ---");
    
    let nft_app = App {
        tag: NFT,
        identity: token_app.identity.clone(),
        vk: token_app.vk.clone(),
    };

    let nft_inputs: Vec<NftContent> = charm_values(&nft_app, tx.ins.iter().map(|(_, v)| v))
        .filter_map(|data| data.value::<NftContent>().ok())
        .collect();

    if nft_inputs.is_empty() {
        eprintln!("❌ Error: No NFT found in inputs for ID: {}", nft_app.identity);
        return false; 
    }
    
    let nft_in = &nft_inputs[0];
    let incoming_supply = nft_in.remaining;
    eprintln!("✅ Incoming Supply: {}", incoming_supply);

    let nft_outputs: Vec<NftContent> = charm_values(&nft_app, tx.outs.iter())
        .filter_map(|data| data.value::<NftContent>().ok())
        .collect();

    if nft_outputs.is_empty() {
        eprintln!("❌ Error: No NFT found in outputs");
        return false;
    }
    
    let nft_out = &nft_outputs[0];
    let outgoing_supply = nft_out.remaining;
    eprintln!("✅ Outgoing Supply: {}", outgoing_supply);

    if incoming_supply < outgoing_supply {
        eprintln!("❌ Error: Supply increased ({} < {})", incoming_supply, outgoing_supply);
        return false;
    }
    
    let tokens_to_mint = incoming_supply - outgoing_supply;

    let input_tokens = match sum_token_amount(token_app, tx.ins.iter().map(|(_, v)| v)) {
        Ok(amount) => amount,
        Err(_) => 0,
    };
    
    let output_tokens = match sum_token_amount(token_app, tx.outs.iter()) {
        Ok(amount) => amount,
        Err(_) => {
            eprintln!("❌ Error: Failed to calculate output tokens");
            return false;
        }
    };
    
    let tokens_created = output_tokens - input_tokens;

    eprintln!("📊 Created: {}, Expected: {}", tokens_created, tokens_to_mint);

    if tokens_created != tokens_to_mint {
        eprintln!("❌ Error: Supply math mismatch (created={}, expected={})", 
                  tokens_created, tokens_to_mint);
        return false;
    }

    eprintln!("✅ Token Mint Satisfied!");
    true
}

// --------------------------------------------------------------------------------
// Hash Function (SHA256)
// --------------------------------------------------------------------------------
pub(crate) fn hash(data: &str) -> B32 {
    let hash = Sha256::digest(data);
    B32(hash.into())
}

// --------------------------------------------------------------------------------
// WASM Bridge Functions for Strict Type-Marshalling
// This replaces the find-and-replace logic with typed marshalling
// Handles both NFT creation and Batch Hiring by converting JS strings into SDK binary types
// --------------------------------------------------------------------------------

#[cfg(feature = "wasm-bridge")]
#[wasm_bindgen]
pub fn process_spell_template(_template_yaml: &str, variables_json: &str) -> Result<String, JsValue> {
    // 1. Parse the typed variables from Node.js
    let vars: BridgeVariables = serde_json::from_str(variables_json)
        .map_err(|e| JsValue::from_str(&format!("Input Parse Error: {}", e)))?;

    // 2. Marshall Binary Types (Solves "expected bytes" error)
    // Convert string UTXOs to UtxoId (binary type)
    let anchor_id = UtxoId::from_str(&vars.anchor_utxo)
        .map_err(|_| JsValue::from_str("Invalid anchor UTXO format. Expected 'txid:vout'"))?;
    
    let funding_id = UtxoId::from_str(&vars.funding_utxo)
        .map_err(|_| JsValue::from_str("Invalid funding UTXO format. Expected 'txid:vout'"))?;
    
    // Convert hex destination string to bytes
    let treasury_dest = hex::decode(&vars.treasury_dest)
        .map_err(|_| JsValue::from_str("Invalid treasury dest hex string"))?;

    // 3. Parse numeric values from strings
    let remaining = vars.remaining.parse::<u64>()
        .map_err(|_| JsValue::from_str("Invalid remaining: must be a number"))?;
    
    let scroll_policy = vars.scroll_policy.parse::<u8>()
        .map_err(|_| JsValue::from_str("Invalid scrollPolicy: must be 0 or 1"))?;
    
    let pay_period_seconds = vars.pay_period_seconds.parse::<u64>()
        .map_err(|_| JsValue::from_str("Invalid payPeriodSeconds: must be a number"))?;
    
    let compensation_sats = vars.compensation_sats.parse::<u64>()
        .map_err(|_| JsValue::from_str("Invalid compensationSats: must be a number"))?;

    // 4. Build Typed Outputs (Solves "expected integer" error)
    let mut outs = Vec::new();
    
    if vars.type_name == "mint-nft" {
        // Single NFT output
        outs.push(serde_json::json!({
            "0": {
                "ticker": vars.ticker,
                "remaining": remaining,
                "metadataHash": vars.metadata_hash,
                "scrollPolicy": scroll_policy,
                "payPeriodSeconds": pay_period_seconds,
                "compensationSats": compensation_sats
            }
        }));
    } else {
        // Handle Batch Hiring: M workers + 1 NFT return
        // Worker outputs use key "1" (fungible token output)
        if let (Some(dests), Some(amounts)) = (vars.worker_dests, vars.token_amounts) {
            if dests.len() != amounts.len() {
                return Err(JsValue::from_str("worker_dests and token_amounts length mismatch"));
            }
            for (i, amount_str) in amounts.iter().enumerate() {
                let amount = amount_str.parse::<u64>()
                    .map_err(|_| JsValue::from_str(&format!("Invalid token amount at index {}: must be a number", i)))?;
                outs.push(serde_json::json!({ "1": amount }));
            }
        }
        
        // NFT return output uses key "0" (authority NFT output)
        outs.push(serde_json::json!({
            "0": {
                "ticker": vars.ticker,
                "remaining": remaining,
                "metadataHash": vars.metadata_hash,
                "scrollPolicy": scroll_policy,
                "payPeriodSeconds": pay_period_seconds,
                "compensationSats": compensation_sats
            }
        }));
    }

    // 5. Generate Final Marshall Object
    let spell = serde_json::json!({
        "version": 11,
        "tx": {
            "ins": [anchor_id, funding_id],
            "outs": outs,
            "coins": [{
                "amount": 1000,
                "dest": treasury_dest
            }]
        },
        "app_public_inputs": {
            format!("n/{}/{}", vars.app_id, vars.app_vk): serde_json::Value::Null
        }
    });

    // 6. Serialize to JSON string for return to Node.js
    serde_json::to_string(&spell)
        .map_err(|e| JsValue::from_str(&format!("Serialization Error: {}", e)))
}

// --------------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use charms_sdk::data::UtxoId;

    #[test]
    fn test_hash() {
        let utxo_id =
            UtxoId::from_str("dc78b09d767c8565c4a58a95e7ad5ee22b28fc1685535056a395dc94929cdd5f:1")
                .unwrap();
        let data = utxo_id.to_string();
        let expected = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";
        assert_eq!(&hash(&data).to_string(), expected);
    }

    #[test]
    fn test_nft_content_validation() {
        let test_hash = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";
        
        let valid = NftContent {
            ticker: "CHARMS-PAY".to_string(),
            remaining: 1,
            metadata_hash: test_hash.to_string(),
            scroll_policy: 0,
            pay_period_seconds: 1209600,
            compensation_sats: 5000000,
        };
        assert!(valid.validate());
        assert!(valid.is_time_based());
        assert!(!valid.is_proof_based());

        let valid_proof = NftContent {
            scroll_policy: 1,
            ..valid.clone()
        };
        assert!(valid_proof.validate());
        assert!(!valid_proof.is_time_based());
        assert!(valid_proof.is_proof_based());

        let invalid_ticker = NftContent {
            ticker: "".to_string(),
            ..valid.clone()
        };
        assert!(!invalid_ticker.validate());

        let invalid_hash = NftContent {
            metadata_hash: "".to_string(),
            ..valid.clone()
        };
        assert!(!invalid_hash.validate());

        let invalid_period = NftContent {
            pay_period_seconds: 0,
            ..valid.clone()
        };
        assert!(!invalid_period.validate());

        let invalid_policy = NftContent {
            scroll_policy: 2,
            ..valid.clone()
        };
        assert!(!invalid_policy.validate());

        let invalid_compensation = NftContent {
            compensation_sats: 500,
            ..valid
        };
        assert!(!invalid_compensation.validate());
    }

    #[test]
    fn test_nft_content_serialization() {
        let test_hash = "f54f6d40bd4ba808b188963ae5d72769ad5212dd1d29517ecc4063dd9f033faa";
        
        let content = NftContent {
            ticker: "CHARMS-PAY".to_string(),
            remaining: 1,
            metadata_hash: test_hash.to_string(),
            scroll_policy: 1,
            pay_period_seconds: 604800,
            compensation_sats: 2500000,
        };

        let serialized = serde_json::to_string(&content).unwrap();
        let deserialized: NftContent = serde_json::from_str(&serialized).unwrap();
        assert_eq!(content, deserialized);
        
        assert!(serialized.contains("\"metadataHash\""));
        assert!(serialized.contains("\"scrollPolicy\""));
        assert!(serialized.contains("\"payPeriodSeconds\""));
        assert!(serialized.contains("\"compensationSats\""));
        assert!(!serialized.contains("\"metadata_hash\""));
        assert!(!serialized.contains("\"scroll_policy\""));
        assert!(!serialized.contains("\"pay_period_seconds\""));
        assert!(!serialized.contains("\"compensation_sats\""));
        assert!(serialized.contains("\"scrollPolicy\":1"));
    }

    #[cfg(feature = "wasm-bridge")]
    #[test]
    fn test_bridge_variables_deserialization() {
        let json = r#"{
            "type_name": "mint-nft",
            "anchor_utxo": "abc123:0",
            "funding_utxo": "def456:1",
            "ticker": "TEST-PAY",
            "remaining": "100",
            "metadata_hash": "hash123",
            "scroll_policy": "0",
            "pay_period_seconds": "1209600",
            "compensation_sats": "5000000",
            "treasury_dest": "5120abc",
            "app_id": "app123",
            "app_vk": "vk456"
        }"#;
        
        let vars: BridgeVariables = serde_json::from_str(json).unwrap();
        assert_eq!(vars.type_name, "mint-nft");
        assert_eq!(vars.anchor_utxo, "abc123:0");
        assert_eq!(vars.ticker, "TEST-PAY");
        assert_eq!(vars.remaining, "100");
    }

    #[cfg(feature = "wasm-bridge")]
    #[test]
    fn test_bridge_variables_with_workers() {
        let json = r#"{
            "type_name": "mint-token",
            "anchor_utxo": "abc123:0",
            "funding_utxo": "def456:1",
            "ticker": "TEST-PAY",
            "remaining": "97",
            "metadata_hash": "hash123",
            "scroll_policy": "0",
            "pay_period_seconds": "1209600",
            "compensation_sats": "1000",
            "treasury_dest": "5120abc",
            "app_id": "app123",
            "app_vk": "vk456",
            "worker_dests": ["addr1", "addr2", "addr3"],
            "token_amounts": ["1", "1", "1"]
        }"#;
        
        let vars: BridgeVariables = serde_json::from_str(json).unwrap();
        assert_eq!(vars.type_name, "mint-token");
        assert_eq!(vars.worker_dests.as_ref().unwrap().len(), 3);
        assert_eq!(vars.token_amounts.as_ref().unwrap().len(), 3);
    }
}