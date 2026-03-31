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
// REMOVED: #[cfg_attr(feature = "wasm-bridge", wasm_bindgen)]
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
    let w_str = match w.value::<String>() {
        Ok(val) => val,
        Err(_) => return false,
    };
    
    if hash(&w_str) != app.identity {
        return false;
    }
    
    let w_utxo_id = match UtxoId::from_str(&w_str) {
        Ok(id) => id,
        Err(_) => return false,
    };
    
    let is_nft_minting = tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id);
    
    if is_nft_minting {
        if !tx.ins.iter().any(|(utxo_id, _)| utxo_id == &w_utxo_id) {
            return false;
        }
    }
    
    let nft_outputs: Vec<&Data> = charm_values(app, tx.outs.iter()).collect();
    
    if nft_outputs.is_empty() {
        return false;
    }
    
    if is_nft_minting && nft_outputs.len() != 1 {
        return false;
    }
    
    for (i, data) in nft_outputs.iter().enumerate() {
        let content: NftContent = match data.value() {
            Ok(c) => c,
            Err(_) => return false,
        };
        
        if !content.validate() {
            return false;
        }
        
        if is_nft_minting && i == 0 {
            if content.ticker.is_empty() {
                return false;
            }
        }
    }
    
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
// WASM Bridge Functions for Template Processing
// These are ONLY included when building with 'wasm-bridge' feature
// These functions use standard types (String, HashMap) that are compatible with wasm-bindgen
// --------------------------------------------------------------------------------

#[cfg(feature = "wasm-bridge")]
fn substitute_variables(
    mut value: serde_yaml::Value,
    vars: &HashMap<String, String>
) -> serde_yaml::Value {
    match &mut value {
        serde_yaml::Value::String(s) => {
            for (key, val) in vars {
                let pattern = format!("{{{{{}}}}}", key);
                if s.contains(&pattern) {
                    *s = s.replace(&pattern, val);
                }
            }
            value
        }
        serde_yaml::Value::Mapping(map) => {
            for (_, v) in map.iter_mut() {
                *v = substitute_variables(v.clone(), vars);
            }
            value
        }
        serde_yaml::Value::Sequence(seq) => {
            for item in seq.iter_mut() {
                *item = substitute_variables(item.clone(), vars);
            }
            value
        }
        _ => value,
    }
}

#[cfg(feature = "wasm-bridge")]
fn transform_identity_keys(mut value: serde_yaml::Value) -> serde_yaml::Value {
    match &mut value {
        serde_yaml::Value::Mapping(map) => {
            let mut new_map = serde_yaml::Mapping::new();
            
            for (key, val) in map.iter() {
                if let serde_yaml::Value::String(key_str) = key {
                    let parts: Vec<&str> = key_str.split('/').collect();
                    if parts.len() == 3 && (parts[0] == "n" || parts[0] == "t") {
                        let array_key = serde_yaml::Value::Sequence(vec![
                            serde_yaml::Value::String(parts[0].to_string()),
                            serde_yaml::Value::String(parts[1].to_string()),
                            serde_yaml::Value::String(parts[2].to_string()),
                        ]);
                        new_map.insert(array_key, val.clone());
                    } else {
                        new_map.insert(key.clone(), transform_identity_keys(val.clone()));
                    }
                } else {
                    new_map.insert(key.clone(), transform_identity_keys(val.clone()));
                }
            }
            
            serde_yaml::Value::Mapping(new_map)
        }
        serde_yaml::Value::Sequence(seq) => {
            let new_seq: Vec<serde_yaml::Value> = seq
                .iter()
                .map(|item| transform_identity_keys(item.clone()))
                .collect();
            serde_yaml::Value::Sequence(new_seq)
        }
        _ => value,
    }
}

#[cfg(feature = "wasm-bridge")]
#[wasm_bindgen]
pub fn process_spell_template(template_yaml: &str, variables_json: &str) -> Result<String, JsValue> {
    let vars: HashMap<String, String> = serde_json::from_str(variables_json)
        .map_err(|e| JsValue::from_str(&format!("JSON Parse Error: {}", e)))?;

    let mut yaml_val: serde_yaml::Value = serde_yaml::from_str(template_yaml)
        .map_err(|e| JsValue::from_str(&format!("YAML Parse Error: {}", e)))?;

    yaml_val = substitute_variables(yaml_val, &vars);
    yaml_val = transform_identity_keys(yaml_val);

    let json_val = serde_json::to_value(&yaml_val)
        .map_err(|e| JsValue::from_str(&format!("JSON Conversion Error: {}", e)))?;

    serde_json::to_string(&json_val)
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
    fn test_transform_identity_keys() {
        let input = serde_yaml::from_str(r#"
app_public_inputs:
  "n/abc123/vk456": null
  "t/def789/vk000": null
"#).unwrap();
        
        let transformed = transform_identity_keys(input);
        
        let yaml_string = serde_yaml::to_string(&transformed).unwrap();
        assert!(yaml_string.contains("- n"));
        assert!(yaml_string.contains("- abc123"));
        assert!(yaml_string.contains("- vk456"));
        assert!(!yaml_string.contains("n/abc123/vk456"));
    }

    #[cfg(feature = "wasm-bridge")]
    #[test]
    fn test_process_spell_template_with_identity_transform() {
        let template = r#"
version: 11
tx:
  ins:
    - "{{anchor_utxo}}"
    - "{{funding_utxo}}"
  outs:
    - 0:
        ticker: "{{ticker}}"
        remaining: {{remaining}}
  coins:
    - amount: 1000
      dest: "{{treasury_hex_dest}}"
app_public_inputs:
  "n/{{app_id}}/{{vk}}": null
"#;
        
        let vars = serde_json::json!({
            "anchor_utxo": "abc123:0",
            "funding_utxo": "def456:1",
            "ticker": "TEST-PAY",
            "remaining": "100",
            "treasury_hex_dest": "5120abc...",
            "app_id": "test123",
            "vk": "vk456"
        });
        
        let result = process_spell_template(template, &vars.to_string()).unwrap();
        
        assert!(result.contains(r#"[["n","test123","vk456"],null]"#) || 
                result.contains(r#"[["n","test123","vk456"],null]"#));
        assert!(!result.contains(r#""n/test123/vk456""#));
        assert!(result.contains("TEST-PAY"));
        assert!(result.contains("abc123:0"));
    }
}